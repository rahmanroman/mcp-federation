/**
 * Mock downstream: MCP server protected by a minimal OAuth 2.1 server (DCR + PKCE + refresh).
 * Standalone: npm run mock -- <port> <name> [tool,tool,...]
 */
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, isInitializeRequest, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface MockOptions {
  port: number;
  name: string;
  tools: string[];
  tokenTtlSec?: number;
  dcr?: boolean;
}

export interface Mock {
  base: string;
  url: string;
  /** Invalidates all access and refresh tokens → forces re-authorization. */
  revokeAll(): void;
  /** Invalidates access tokens only → gateway must refresh silently. */
  expireAccess(): void;
  /** Drops all MCP sessions → gateway gets 404 and must reconnect. */
  dropSessions(): void;
  setTools(tools: string[]): void;
  stats: { authorizations: number; refreshes: number; registrations: number };
  close(): Promise<void>;
}

export async function startMock(opts: MockOptions): Promise<Mock> {
  const base = `http://127.0.0.1:${opts.port}`;
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const access = new Set<string>();
  const refresh = new Set<string>();
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();
  let tools = opts.tools;
  const stats = { authorizations: 0, refreshes: 0, registrations: 0 };

  const issue = () => {
    const a = randomUUID();
    const r = randomUUID();
    access.add(a);
    refresh.add(r);
    return { access_token: a, refresh_token: r, token_type: "Bearer", expires_in: opts.tokenTtlSec ?? 3600 };
  };

  const json = (res: http.ServerResponse, status: number, body: unknown) =>
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));

  const readBody = (req: http.IncomingMessage) =>
    new Promise<string>((resolve) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => resolve(s));
    });

  const makeServer = () => {
    const server = new Server({ name: opts.name, version: "1.0.0" }, { capabilities: { tools: { listChanged: true } }, instructions: `${opts.name} mock service` });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((t) => ({
        name: t,
        description: `${t} tool of ${opts.name}`,
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => ({
      content: [{ type: "text", text: `${opts.name}.${req.params.name}(${JSON.stringify(req.params.arguments ?? {})})` }],
    }));
    return server;
  };

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url!, base);
    const p = url.pathname;

    if (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/mcp") {
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["read", "write", "offline_access"] });
    }
    if (p === "/.well-known/oauth-authorization-server" || p === "/.well-known/openid-configuration") {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        ...(opts.dcr === false ? {} : { registration_endpoint: `${base}/register` }),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (p === "/register" && req.method === "POST") {
      stats.registrations++;
      const meta = JSON.parse(await readBody(req));
      return json(res, 201, { ...meta, client_id: `client-${randomUUID()}`, client_id_issued_at: Math.floor(Date.now() / 1000) });
    }
    if (p === "/authorize") {
      const code = randomUUID();
      const redirect = url.searchParams.get("redirect_uri")!;
      codes.set(code, { challenge: url.searchParams.get("code_challenge")!, redirect });
      const to = new URL(redirect);
      to.searchParams.set("code", code);
      to.searchParams.set("state", url.searchParams.get("state") ?? "");
      return res.writeHead(302, { Location: to.toString() }).end();
    }
    if (p === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      if (form.get("grant_type") === "authorization_code") {
        const c = codes.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (!c || c.challenge !== challenge) return json(res, 400, { error: "invalid_grant" });
        codes.delete(form.get("code")!);
        stats.authorizations++;
        return json(res, 200, issue());
      }
      if (form.get("grant_type") === "refresh_token") {
        const r = form.get("refresh_token") ?? "";
        if (!refresh.has(r)) return json(res, 400, { error: "invalid_grant" });
        refresh.delete(r);
        stats.refreshes++;
        return json(res, 200, issue());
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }

    if (p === "/mcp") {
      const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
      if (!access.has(token)) {
        return res
          .writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` })
          .end();
      }
      const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "null") : undefined;
      const sid = req.headers["mcp-session-id"] as string | undefined;
      if (sid) {
        const s = sessions.get(sid);
        if (!s) return json(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
        return s.transport.handleRequest(req, res, body);
      }
      if (!isInitializeRequest(body)) return json(res, 400, { error: "no session" });
      const server = makeServer();
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => sessions.set(id, { transport, server }),
      });
      await server.connect(transport);
      return transport.handleRequest(req, res, body);
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((r) => httpServer.listen(opts.port, "127.0.0.1", () => r()));

  return {
    base,
    url: `${base}/mcp`,
    stats,
    revokeAll: () => {
      access.clear();
      refresh.clear();
    },
    expireAccess: () => access.clear(),
    dropSessions: () => {
      for (const s of sessions.values()) s.server.close().catch(() => {});
      sessions.clear();
    },
    setTools: (t) => {
      tools = t;
      for (const s of sessions.values()) s.server.sendToolListChanged().catch(() => {});
    },
    close: async () => {
      for (const s of sessions.values()) await s.server.close().catch(() => {});
      httpServer.closeAllConnections();
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("test/mock-downstream.ts")) {
  const [port = "4101", name = "mock", toolList = "search,get"] = process.argv.slice(2);
  const m = await startMock({ port: Number(port), name, tools: toolList.split(",") });
  console.log(`Mock "${name}" on ${m.url}`);
}
