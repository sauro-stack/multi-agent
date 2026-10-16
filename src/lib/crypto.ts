import "server-only";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Secret vault.
 *
 * Provider API keys are encrypted at rest with AES-256-GCM. The symmetric key
 * is derived (scrypt) from a master secret that lives either in
 * `LAB_SESSION_SECRET` or in a 0600 file outside version control.
 *
 * Payload format: `v1:<iv-b64>:<tag-b64>:<ciphertext-b64>`
 */

const VERSION = "v1";
const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const SCRYPT_SALT = "arl/vault/v1";

export class VaultConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultConfigError";
  }
}

let cachedKey: Buffer | null = null;

function secretFile(): string {
  return process.env.LAB_SECRET_FILE ?? path.join(process.cwd(), "data", "master.key");
}

function loadMasterSecret(): string {
  const fromEnv = process.env.LAB_SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  if (fromEnv && fromEnv.length > 0) {
    throw new VaultConfigError(
      "LAB_SESSION_SECRET must be at least 16 characters. Refusing to run with a weak vault key.",
    );
  }

  const file = secretFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 16) return existing;
  }
  const generated = crypto.randomBytes(48).toString("base64url");
  fs.writeFileSync(file, generated, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort on exotic filesystems */
  }
  return generated;
}

function vaultKey(): Buffer {
  if (!cachedKey) {
    cachedKey = crypto.scryptSync(loadMasterSecret(), SCRYPT_SALT, KEY_LEN);
  }
  return cachedKey;
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext) throw new VaultConfigError("Cannot encrypt an empty secret");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, vaultKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(
    ":",
  );
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new VaultConfigError("Malformed secret payload");
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv(ALGO, vaultKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** `sk-proj-...9f2c` -> `sk-…9f2c`. Safe to persist and render. */
export function keyHint(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 8) return "…";
  const prefix = trimmed.slice(0, 3);
  return `${prefix}…${trimmed.slice(-4)}`;
}

const SECRET_SHAPED = [
  /\b(sk|pk|rk)-[A-Za-z0-9_\-]{8,}/g,
  /\bsk-ant-[A-Za-z0-9_\-]{8,}/g,
  /\bAIza[A-Za-z0-9_\-]{20,}/g,
  /\bgsk_[A-Za-z0-9_\-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9_\-.]{12,}/gi,
];

/**
 * Last line of defence before a message reaches a log or a response body.
 * Provider errors frequently echo the offending key back at us.
 */
export function scrubSecrets(input: string): string {
  let out = input;
  for (const pattern of SECRET_SHAPED) {
    out = out.replace(pattern, (match) => `${match.slice(0, 3)}…[redacted]`);
  }
  return out;
}

/** Redacts `apiKey`-style fields from arbitrary JSON-ish structures. */
export function scrubObject<T>(value: T): T {
  if (typeof value === "string") return scrubSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => scrubObject(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = /key|secret|token|authorization/i.test(k) ? "[redacted]" : scrubObject(v);
    }
    return out as unknown as T;
  }
  return value;
}
