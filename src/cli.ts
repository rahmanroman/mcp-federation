import { parseArgs } from "node:util";
import { effectivePort, effectiveScope, isValidServiceName, loadConfig, saveConfig } from "./config.js";
import { loadClient, loadTokens, tokenStatus } from "./auth/storage.js";
import type { GatewayStatus } from "./gateway/server.js";
import { startGateway } from "./index.js";

const USAGE = `Usage:
  mcp-federation start [-p | --port <n>] [--notify]
  mcp-federation add <name> <url> [--prefix <p>]
  mcp-federation remove <name>
  mcp-federation list
  mcp-federation get <name>`;

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "start":
      return start(rest);
    case "add":
      return add(rest);
    case "remove":
      return remove(rest);
    case "list":
      return list();
    case "get":
      return get(rest);
    case undefined:
    case "-h":
    case "--help":
    case "help":
      console.log(USAGE);
      return;
    default:
      fail(`Unknown command "${command}"\n\n${USAGE}`);
  }
}

class CliError extends Error {}
function fail(msg: string): never {
  throw new CliError(msg);
}
export const isCliError = (e: unknown) => e instanceof CliError;

async function start(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { port: { type: "string", short: "p" }, notify: { type: "boolean" } },
  });
  let port: number | undefined;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`Invalid port "${values.port}"`);
  }

  const gateway = await startGateway({ port, notify: values.notify });
  const shutdown = async () => {
    console.log("\nShutting down...");
    await gateway.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function add(args: string[]): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { prefix: { type: "string" } } });
  const [name, url] = positionals;
  if (!name || !url || positionals.length > 2) fail("Usage: mcp-federation add <name> <url> [--prefix <p>]");
  if (!isValidServiceName(name)) fail(`Invalid service name "${name}" (allowed: letters, digits, _ -)`);
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
  } catch {
    fail(`Invalid url "${url}"`);
  }

  const cfg = loadConfig();
  if (cfg.services[name]) fail(`Service "${name}" already exists. Remove it first: mcp-federation remove ${name}`);
  cfg.services[name] = { url, ...(values.prefix ? { toolPrefix: values.prefix } : {}) };
  saveConfig(cfg);
  console.log(`Added "${name}" → ${url}${values.prefix ? ` (toolPrefix "${values.prefix}")` : ""}`);
  console.log("Restart the gateway to apply.");
}

function remove(args: string[]): void {
  const [name] = args;
  if (!name) fail("Usage: mcp-federation remove <name>");
  const cfg = loadConfig();
  if (!cfg.services[name]) fail(`Service "${name}" not found`);
  delete cfg.services[name];
  saveConfig(cfg);
  console.log(`Removed "${name}". Saved tokens are kept. Restart the gateway to apply.`);
}

function list(): void {
  const cfg = loadConfig();
  const rows = Object.entries(cfg.services).map(([name, svc]) => [
    name,
    svc.url,
    effectiveScope(svc),
    tokenStatus(loadTokens(name)),
  ]);
  if (rows.length === 0) {
    console.log("No services configured. Add one with: mcp-federation add <name> <url>");
    return;
  }
  printTable(["NAME", "URL", "SCOPE", "AUTH"], rows);
}

async function get(args: string[]): Promise<void> {
  const [name] = args;
  if (!name) fail("Usage: mcp-federation get <name>");
  const cfg = loadConfig();
  const svc = cfg.services[name];
  if (!svc) fail(`Service "${name}" not found`);

  const tokens = loadTokens(name);
  const status = tokenStatus(tokens);
  const client = svc.clientId ? { client_id: svc.clientId } : loadClient(name);
  const expires = status === "valid" && tokens?.expires_at ? ` (expires ${new Date(tokens.expires_at).toISOString()})` : "";

  console.log(`name:       ${name}`);
  console.log(`url:        ${svc.url}`);
  console.log(`scope:      ${effectiveScope(svc)}`);
  if (svc.toolPrefix) console.log(`toolPrefix: ${svc.toolPrefix}`);
  if (svc.eager) console.log(`eager:      true`);
  console.log(`auth:       ${status}${expires}`);
  console.log(`client_id:  ${client?.client_id ?? "— (not registered yet)"}${svc.clientId ? " (static, from config)" : ""}`);

  const live = await fetchStatus(effectivePort(cfg));
  if (!live) {
    console.log(`gateway:    not running`);
    return;
  }
  const s = live.services.find((x) => x.name === name);
  if (!s) {
    console.log(`gateway:    running, but "${name}" is not loaded (restart the gateway)`);
    return;
  }
  console.log(`state:      ${s.state}${s.error ? ` — ${s.error}` : ""}`);
  if (s.authUrl && s.state === "pending_auth") console.log(`auth url:   ${s.authUrl}`);
  if (s.activeInSessions === 0 && !s.eager) {
    console.log(`tools:      not activated in any active session`);
  } else {
    console.log(`tools:      active in ${s.eager ? "all sessions (eager)" : `${s.activeInSessions} session(s)`}`);
    for (const t of s.tools) console.log(`  - ${t}`);
  }
}

async function fetchStatus(port: number): Promise<GatewayStatus | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? ((await res.json()) as GatewayStatus) : undefined;
  } catch {
    return undefined;
  }
}

function printTable(header: string[], rows: string[][]): void {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  console.log(fmt(header));
  for (const r of rows) console.log(fmt(r));
}
