import http from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  isInitializeRequest,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../config.js";
import { DownstreamService, errorResult } from "../downstreams/service.js";
import { ToolRegistry } from "./registry.js";
import { SESSION_IDLE_MS, type Session } from "./session.js";
import { describeScope, GATEWAY_CALL, GATEWAY_INFO, gatewayCallTool, gatewayInfoTool } from "./tools.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export class Gateway {
  readonly services: DownstreamService[];
  readonly registry: ToolRegistry;
  private sessions = new Map<string, Session>();
  private http?: http.Server;
  private sweepTimer?: NodeJS.Timeout;

  constructor(private readonly cfg: Config, private readonly port: number) {
    // Object order of config.services = collision priority
    this.services = Object.entries(cfg.services).map(([name, svc]) => new DownstreamService(name, svc));
    this.registry = new ToolRegistry(this.services);
    for (const svc of this.services) {
      svc.on("tools", () => this.onToolsChanged(svc.name));
    }
  }

  private service(name: string): DownstreamService | undefined {
    return this.services.find((s) => s.name === name);
  }

  private isEager(scope: string): boolean {
    return this.cfg.lazy === false || this.service(scope)?.cfg.eager === true;
  }

  private visible(session: Session, scope: string): boolean {
    return this.isEager(scope) || session.activeScopes.has(scope);
  }

  private onToolsChanged(scope: string): void {
    this.registry.rebuild();
    for (const s of this.sessions.values()) {
      if (this.visible(s, scope)) s.server.sendToolListChanged().catch(() => {});
    }
  }

  // ---------- MCP handlers ----------

  private createSession(): Session {
    const server = new Server(
      { name: "mcp-federation", version: "0.1.0" },
      { capabilities: { tools: { listChanged: true } } },
    );
    const session: Session = {
      id: "",
      server,
      activeScopes: new Set(),
      lastSeen: Date.now(),
      transport: new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          session.id = sid;
          this.sessions.set(sid, session);
        },
        onsessionclosed: (sid) => this.closeSession(sid),
      }),
    };
    session.transport.onclose = () => session.id && this.closeSession(session.id);
    server.oninitialized = () => {
      session.clientName = server.getClientVersion()?.name;
      console.log(`[gateway] Session opened: ${session.clientName ?? "unknown client"} (${session.id.slice(0, 8)})`);
    };

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Tool[] = [gatewayInfoTool(this.services), gatewayCallTool];
      for (const svc of this.services) {
        if (this.visible(session, svc.name)) tools.push(...this.registry.forScope(svc.name).map((e) => e.tool));
      }
      return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const { name, arguments: args } = req.params;
      if (name === GATEWAY_INFO) return this.handleInfo(session, args);

      let toolName = name;
      let toolArgs = args;
      if (name === GATEWAY_CALL) {
        toolName = String(args?.tool ?? "");
        toolArgs = (args?.arguments as Record<string, unknown> | undefined) ?? {};
      }

      const entry = this.registry.get(toolName);
      if (!entry) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
      // Known tool but scope not active (e.g. name remembered from an earlier session) — activate implicitly
      this.activate(session, entry.scope);

      const progressToken = req.params._meta?.progressToken;
      return this.service(entry.scope)!.callTool(entry.originalName, toolArgs, {
        signal: extra.signal,
        onprogress: progressToken === undefined
          ? undefined
          : (p) => {
              extra.sendNotification({ method: "notifications/progress", params: { ...p, progressToken } }).catch(() => {});
            },
      });
    });

    return session;
  }

  private handleInfo(session: Session, args: Record<string, unknown> | undefined): CallToolResult {
    const svc = this.service(String(args?.service ?? ""));
    if (!svc) {
      return errorResult(`Unknown service "${args?.service}". Available: ${this.services.map((s) => s.name).join(", ")}`);
    }
    this.activate(session, svc.name);
    return { content: [{ type: "text", text: describeScope(svc, this.registry.forScope(svc.name), args?.include_schemas === true) }] };
  }

  private activate(session: Session, scope: string): void {
    if (session.activeScopes.has(scope)) return;
    session.activeScopes.add(scope);
    if (!this.isEager(scope)) session.server.sendToolListChanged().catch(() => {});
  }

  private closeSession(sid: string): void {
    const s = this.sessions.get(sid);
    if (!s) return;
    this.sessions.delete(sid);
    console.log(`[gateway] Session closed: ${s.clientName ?? "unknown client"} (${sid.slice(0, 8)})`);
    s.server.close().catch(() => {});
  }

  // ---------- HTTP ----------

  async listen(): Promise<void> {
    this.http = http.createServer((req, res) => {
      this.handleHttp(req, res).catch((e) => {
        console.error(`[gateway] Request failed: ${e.message}`);
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.http!.once("error", (e: any) =>
        reject(e.code === "EADDRINUSE" ? new Error(`Port ${this.port} is in use — pass --port or set "port" in config.json`) : e),
      );
      this.http!.listen(this.port, "127.0.0.1", () => resolve());
    });
    this.sweepTimer = setInterval(() => this.sweep(), 60_000).unref();
  }

  async close(): Promise<void> {
    clearInterval(this.sweepTimer);
    for (const sid of [...this.sessions.keys()]) this.closeSession(sid);
    await Promise.all(this.services.map((s) => s.stop()));
    await new Promise<void>((r) => (this.http ? this.http.close(() => r()) : r()));
  }

  private sweep(): void {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const s of [...this.sessions.values()]) {
      if (s.lastSeen < cutoff) this.closeSession(s.id);
    }
  }

  private checkOrigin(req: http.IncomingMessage): boolean {
    const allowed = [`127.0.0.1:${this.port}`, `localhost:${this.port}`];
    if (!allowed.includes(req.headers.host ?? "")) return false;
    const origin = req.headers.origin;
    return !origin || allowed.some((h) => origin === `http://${h}`);
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.checkOrigin(req)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (url.pathname === "/status" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(this.status()));
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }

    const body = req.method === "POST" ? await readBody(req) : undefined;
    if (body instanceof Error) {
      res.writeHead(400).end(body.message);
      return;
    }

    const sid = req.headers["mcp-session-id"];
    if (typeof sid === "string") {
      const session = this.sessions.get(sid);
      if (!session) {
        // Unknown/expired session → client must re-initialize
        res.writeHead(404, { "Content-Type": "application/json" }).end(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }),
        );
        return;
      }
      session.lastSeen = Date.now();
      await session.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method !== "POST" || !isInitializeRequest(body)) {
      res.writeHead(400, { "Content-Type": "application/json" }).end(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Missing Mcp-Session-Id" }, id: null }),
      );
      return;
    }
    const session = this.createSession();
    await session.server.connect(session.transport);
    await session.transport.handleRequest(req, res, body);
  }

  status(): GatewayStatus {
    return {
      port: this.port,
      services: this.services.map((s) => ({
        name: s.name,
        state: s.state,
        authUrl: s.authUrl,
        error: s.lastError,
        tools: this.registry.forScope(s.name).map((e) => e.tool.name),
        eager: this.isEager(s.name),
        activeInSessions: [...this.sessions.values()].filter((x) => x.activeScopes.has(s.name)).length,
      })),
      sessions: [...this.sessions.values()].map((s) => ({
        id: s.id,
        client: s.clientName,
        activeScopes: [...s.activeScopes],
      })),
    };
  }
}

export interface GatewayStatus {
  port: number;
  services: {
    name: string;
    state: string;
    authUrl?: string;
    error?: string;
    tools: string[];
    eager: boolean;
    activeInSessions: number;
  }[];
  sessions: { id: string; client?: string; activeScopes: string[] }[];
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        resolve(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined);
      } catch {
        resolve(new Error("Invalid JSON"));
      }
    });
    req.on("error", (e) => resolve(e));
  });
}
