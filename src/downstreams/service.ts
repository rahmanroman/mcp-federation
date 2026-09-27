import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServiceConfig } from "../config.js";
import { GatewayOAuthProvider } from "../auth/provider.js";
import { cancelCallback, waitForCallback } from "../auth/callback.js";
import { notifyAuthRequired } from "../notify.js";

export type ServiceState = "connecting" | "connected" | "pending_auth" | "error";

const MAX_BACKOFF_MS = 5 * 60_000;
const CALL_TIMEOUT_MS = 5 * 60_000;

/**
 * One downstream MCP server. Emits "tools" when its tool list changes
 * (connected, re-authorized, downstream list_changed) and "state" on state changes.
 */
export class DownstreamService extends EventEmitter {
  state: ServiceState = "connecting";
  tools: Tool[] = [];
  authUrl?: string;
  lastError?: string;
  summary?: string;

  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private provider: GatewayOAuthProvider;
  private authState?: string;
  private retryTimer?: NodeJS.Timeout;
  private backoffMs = 1000;
  private connecting?: Promise<void>;
  private stopped = false;

  constructor(readonly name: string, readonly cfg: ServiceConfig) {
    super();
    this.provider = new GatewayOAuthProvider(name, cfg, (url, state) => this.enterPendingAuth(url, state));
  }

  /** Starts connecting in the background; resolves once the service settled into any state. */
  start(): Promise<void> {
    return this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    if (this.authState) cancelCallback(this.authState);
    await this.client?.close().catch(() => {});
  }

  private connect(): Promise<void> {
    this.connecting ??= this.doConnect().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    await this.client?.close().catch(() => {});
    this.setState("connecting");

    const transport = new StreamableHTTPClientTransport(new URL(this.cfg.url), { authProvider: this.provider });
    const client = new Client({ name: "mcp-federation", version: "0.1.0" }, { capabilities: {} });
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      this.refreshTools().catch((e) => console.warn(`[${this.name}] Failed to refresh tools: ${e.message}`));
    });

    try {
      await client.connect(transport);
    } catch (e) {
      if (e instanceof UnauthorizedError && this.state === "pending_auth") {
        this.transport = transport; // finishAuth runs on this transport
        return;
      }
      this.fail(e);
      return;
    }

    this.client = client;
    this.transport = transport;
    this.summary = this.cfg.description ?? firstLine(client.getInstructions()) ?? client.getServerVersion()?.title;
    try {
      await this.refreshTools();
    } catch (e) {
      this.fail(e);
      return;
    }
    this.backoffMs = 1000;
    this.authUrl = undefined;
    this.lastError = undefined;
    this.setState("connected");
    console.log(`[${this.name}] ✓ Connected (${this.tools.length} tools)`);
  }

  private async refreshTools(): Promise<void> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client!.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    this.tools = tools;
    this.emit("tools");
  }

  /** Called by the OAuth provider when the SDK needs the user to authorize. */
  private enterPendingAuth(url: URL, state: string): void {
    if (this.authState) cancelCallback(this.authState);
    const wasConnected = this.state === "connected";
    this.authUrl = url.toString();
    this.authState = state;
    this.setState("pending_auth");

    console.log(
      `\n[${this.name}] ${wasConnected ? "Session expired. Open to re-authorize" : "Not authorized. Open to authenticate"}:\n  ${this.authUrl}\n`,
    );
    notifyAuthRequired(this.name, this.authUrl);

    waitForCallback(this.name, state)
      .then(async (code) => {
        if (this.authState !== state) return;
        await this.transport!.finishAuth(code);
        this.authState = undefined;
        console.log(`[${this.name}] ✓ Authorized`);
        await this.connect();
      })
      .catch((e) => {
        if (this.authState !== state) return; // superseded
        this.authState = undefined;
        this.fail(e);
      });
  }

  private fail(e: unknown): void {
    this.lastError = describeError(e);
    this.setState("error");
    if (this.stopped) return;
    if (isConfigError(e)) {
      console.warn(`[${this.name}] ✗ ${this.lastError}`);
      return; // not transient — fix config and restart
    }
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    console.warn(`[${this.name}] ✗ ${this.lastError} — retrying in ${Math.round(delay / 1000)}s`);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private setState(s: ServiceState): void {
    if (this.state === s) return;
    const prev = this.state;
    this.state = s;
    this.emit("state", s, prev);
  }

  /** Human-readable reason the service can't take calls right now, or undefined if it can. */
  unavailableReason(): string | undefined {
    switch (this.state) {
      case "connected":
        return undefined;
      case "pending_auth":
        return `Service "${this.name}" requires re-authorization. Ask the user to open this link, then retry:\n${this.authUrl}`;
      case "connecting":
        return `Service "${this.name}" is connecting. Retry in a few seconds.`;
      case "error":
        return `Service "${this.name}" is unavailable (${this.lastError}). The gateway is reconnecting; retry later.`;
    }
  }

  async callTool(name: string, args: Record<string, unknown> | undefined, opts: RequestOptions): Promise<CallToolResult> {
    const reason = this.unavailableReason();
    if (reason) return errorResult(reason);

    const options: RequestOptions = { timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true, ...opts };
    try {
      return (await this.client!.callTool({ name, arguments: args }, undefined, options)) as CallToolResult;
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        // Provider already switched us to pending_auth (refresh failed)
        return errorResult(this.unavailableReason() ?? `Service "${this.name}" rejected the token.`);
      }
      if (e instanceof StreamableHTTPError && e.code === 404) {
        // Downstream session expired — reconnect and retry once
        console.log(`[${this.name}] Downstream session expired, reconnecting`);
        await this.connect();
        const again = this.unavailableReason();
        if (again) return errorResult(again);
        return (await this.client!.callTool({ name, arguments: args }, undefined, options)) as CallToolResult;
      }
      if (isNetworkError(e)) {
        this.fail(e);
        return errorResult(this.unavailableReason()!);
      }
      throw e; // protocol-level error (e.g. invalid params) — pass through to the client
    }
  }
}

export function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function firstLine(s: string | undefined): string | undefined {
  return s?.split("\n").map((l) => l.trim()).find(Boolean);
}

function isNetworkError(e: any): boolean {
  const code = e?.cause?.code ?? e?.code;
  return (
    e instanceof TypeError || // fetch failed
    ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(code) ||
    (e instanceof StreamableHTTPError && (e.code ?? 0) >= 500)
  );
}

function isConfigError(e: any): boolean {
  return /dynamic client registration/i.test(e?.message ?? "");
}

function describeError(e: any): string {
  const msg: string = e?.message ?? String(e);
  if (isConfigError(e)) {
    return (
      `Authorization server does not support Dynamic Client Registration. ` +
      `Register an OAuth client with redirect_uri http://localhost:3118/callback and set "clientId" in config.json`
    );
  }
  const cause = e?.cause?.code ?? e?.cause?.message;
  return cause ? `${msg} (${cause})` : msg;
}
