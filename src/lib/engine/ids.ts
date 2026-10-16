import crypto from "node:crypto";

function random(): string {
  return crypto.randomBytes(6).toString("base64url");
}

export function logId(): string {
  return `log_${Date.now().toString(36)}_${random()}`;
}

export function roomId(): string {
  return `room_${random()}${random().slice(0, 4)}`;
}

export function agentId(): string {
  return `agent_${random()}`;
}

export function sessionId(): string {
  return `sess_${crypto.randomBytes(18).toString("base64url")}`;
}
