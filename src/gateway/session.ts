import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface Session {
  id: string;
  transport: StreamableHTTPServerTransport;
  server: Server;
  activeScopes: Set<string>;
  clientName?: string;
  lastSeen: number;
}

export const SESSION_IDLE_MS = 30 * 60_000;
