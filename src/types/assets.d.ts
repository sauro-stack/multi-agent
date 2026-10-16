// Next.js resolves stylesheet imports through its bundler, but TypeScript's
// stricter side-effect import checking (TS 7) needs an explicit declaration.
declare module "*.css";
declare module "*.scss";
