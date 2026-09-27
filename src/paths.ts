import os from "node:os";
import path from "node:path";

export const DEFAULT_PORT = 3117;
export const CALLBACK_PORT = 3118;
export const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}/callback`;
export const DEFAULT_SCOPE = "read write offline_access";

/** Base directory; MCP_FEDERATION_HOME overrides it (used by tests). */
export function homeDir(): string {
  return process.env.MCP_FEDERATION_HOME ?? path.join(os.homedir(), ".mcp-federation");
}

export const configPath = () => path.join(homeDir(), "config.json");
export const tokensPath = () => path.join(homeDir(), "tokens.json");
export const clientsPath = () => path.join(homeDir(), "clients.json");
