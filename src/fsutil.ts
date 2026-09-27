import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (e: any) {
    if (e.code === "ENOENT") return fallback;
    throw new Error(`Failed to read ${file}: ${e.message}`);
  }
}

/** Atomic write (temp file + rename). `secret` restricts access to the current user. */
export function writeJson(file: string, data: unknown, secret = false): void {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (secret) restrict(dir);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  const isNew = !fs.existsSync(file);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: secret ? 0o600 : 0o644 });
  fs.renameSync(tmp, file);
  if (secret && isNew) restrict(file);
}

function restrict(target: string): void {
  if (process.platform !== "win32") {
    fs.chmodSync(target, fs.statSync(target).isDirectory() ? 0o700 : 0o600);
    return;
  }
  try {
    const user = process.env.USERNAME;
    if (!user) return;
    execFileSync("icacls", [target, "/inheritance:r", "/grant:r", `${user}:F`], { stdio: "ignore" });
  } catch {
    console.warn(`[gateway] WARNING: failed to restrict permissions on ${target}`);
  }
}
