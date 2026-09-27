import http from "node:http";
import { CALLBACK_PORT } from "../paths.js";

type Pending = { service: string; resolve: (code: string) => void; reject: (e: Error) => void };

const pending = new Map<string, Pending>(); // state → waiter
let server: http.Server | undefined;
let listening: Promise<void> | undefined;

/**
 * Waits for the OAuth redirect carrying `state`. Starts the callback server on demand
 * and closes it when no authorizations are pending.
 */
export async function waitForCallback(service: string, state: string): Promise<string> {
  const code = new Promise<string>((resolve, reject) => pending.set(state, { service, resolve, reject }));
  await ensureServer();
  return code.finally(() => {
    pending.delete(state);
    if (pending.size === 0) stopServer();
  });
}

/** Drops a pending authorization (e.g. superseded by a newer flow for the same service). */
export function cancelCallback(state: string): void {
  pending.get(state)?.reject(new Error("Authorization superseded"));
}

function ensureServer(): Promise<void> {
  if (listening) return listening;
  server = http.createServer(handle);
  listening = new Promise((resolve, reject) => {
    server!.once("error", (e: any) => {
      listening = undefined;
      server = undefined;
      reject(
        e.code === "EADDRINUSE"
          ? new Error(`OAuth callback port ${CALLBACK_PORT} is in use — is another mcp-federation running?`)
          : e,
      );
    });
    server!.listen(CALLBACK_PORT, "127.0.0.1", () => resolve());
  });
  return listening;
}

function stopServer(): void {
  server?.close();
  server = undefined;
  listening = undefined;
}

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? "/", `http://localhost:${CALLBACK_PORT}`);
  const state = url.searchParams.get("state") ?? "";
  const waiter = pending.get(state);
  if (req.method !== "GET" || url.pathname !== "/callback" || !waiter) {
    res.writeHead(404).end();
    return;
  }

  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (error || !code) {
    const msg = url.searchParams.get("error_description") ?? error ?? "missing code";
    page(res, 400, `Authorization for "${waiter.service}" failed: ${msg}`);
    waiter.reject(new Error(msg));
    return;
  }

  page(res, 200, `"${waiter.service}" authorized. You can close this tab.`);
  waiter.resolve(code);
}

function page(res: http.ServerResponse, status: number, text: string): void {
  const safe = text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><title>mcp-federation</title>` +
    `<body style="font:16px system-ui;padding:40px">${safe}</body>`);
}
