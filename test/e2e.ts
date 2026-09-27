/**
 * End-to-end: gateway + 3 mock OAuth-protected downstreams + real MCP client.
 *   npm test
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { startMock, type Mock } from "./mock-downstream.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-federation-e2e-"));
process.env.MCP_FEDERATION_HOME = home;
const { startGateway } = await import("../src/index.js");
const { main } = await import("../src/cli.js");

const PORT = 3917;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`Timeout waiting for ${what}`);
    await sleep(25);
  }
}
const text = (r: unknown) => ((r as CallToolResult).content[0] as { text: string }).text;

let passed = 0;
async function step(name: string, fn: () => Promise<void>) {
  process.stdout.write(`\n▶ ${name}\n`);
  await fn();
  passed++;
  process.stdout.write(`✔ ${name}\n`);
}

const jira = await startMock({ port: 4101, name: "jira", tools: ["search", "add_worklog"] });
const bitbucket = await startMock({ port: 4102, name: "bitbucket", tools: ["search", "list_pull_requests"] });
const confluence = await startMock({ port: 4103, name: "confluence", tools: ["search", "get_page"] });
const mocks: Mock[] = [jira, bitbucket, confluence];

fs.writeFileSync(
  path.join(home, "config.json"),
  JSON.stringify({
    port: PORT,
    services: {
      jira: { url: jira.url },
      bitbucket: { url: bitbucket.url }, // "search" collides with jira → jira wins
      confluence: { url: confluence.url, toolPrefix: "confluence_" },
    },
  }),
);

/** Follows the OAuth URL like a browser would: authorize → 302 → gateway callback. */
async function authorize(url: string) {
  const res = await fetch(url, { redirect: "follow" });
  assert.equal(res.status, 200, `callback page status for ${url}`);
}

let gateway = await startGateway();
let client: Client;
let listChanged = 0;

async function connectClient() {
  client = new Client({ name: "e2e", version: "0" });
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    listChanged++;
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));
}
const toolNames = async () => (await client.listTools()).tools.map((t) => t.name).sort();

try {
  await step("non-blocking start: all services pending_auth, gateway listening", async () => {
    assert.deepEqual(gateway.services.map((s) => s.state), ["pending_auth", "pending_auth", "pending_auth"]);
    await connectClient();
    assert.deepEqual(await toolNames(), ["gateway_call", "gateway_info"]);
  });

  await step("gateway_info on pending service returns auth link", async () => {
    const r = await client.callTool({ name: "gateway_info", arguments: { service: "bitbucket" } });
    assert.match(text(r), /requires re-authorization/);
    assert.match(text(r), /http:\/\/127\.0\.0\.1:4102\/authorize/);
  });

  await step("authorize all services via callback (DCR + PKCE)", async () => {
    for (const s of gateway.services) await authorize(s.authUrl!);
    await until(() => gateway.services.every((s) => s.state === "connected"), "all connected");
    assert.deepEqual(mocks.map((m) => m.stats.registrations), [1, 1, 1]);
    const clients = JSON.parse(fs.readFileSync(path.join(home, "clients.json"), "utf8"));
    assert.deepEqual(Object.keys(clients).sort(), ["bitbucket", "confluence", "jira"]);
  });

  await step("lazy activation via gateway_info → list_changed → tools visible", async () => {
    const before = listChanged;
    const r = await client.callTool({ name: "gateway_info", arguments: { service: "jira" } });
    assert.match(text(r), /activated/);
    assert.match(text(r), /add_worklog/);
    await until(() => listChanged > before, "list_changed");
    assert.deepEqual(await toolNames(), ["add_worklog", "gateway_call", "gateway_info", "list_pull_requests", "search"]);
    const search = (await client.listTools()).tools.find((t) => t.name === "search")!;
    assert.match(search.description!, /^\[jira\] /);
  });

  await step("direct call routed to downstream", async () => {
    const r = await client.callTool({ name: "search", arguments: { q: "bug" } });
    assert.equal(text(r), 'jira.search({"q":"bug"})');
  });

  await step("toolPrefix: confluence_get_page → get_page, implicit activation", async () => {
    const r = await client.callTool({ name: "confluence_get_page", arguments: { q: "x" } });
    assert.equal(text(r), 'confluence.get_page({"q":"x"})');
    assert.ok((await toolNames()).includes("confluence_search"));
  });

  await step("collision: bitbucket search hidden, list_pull_requests reachable via gateway_call", async () => {
    const info = await client.callTool({ name: "gateway_info", arguments: { service: "bitbucket", include_schemas: true } });
    assert.doesNotMatch(text(info), /- search:/);
    assert.match(text(info), /inputSchema/);
    const r = await client.callTool({ name: "gateway_call", arguments: { tool: "list_pull_requests", arguments: { q: "1" } } });
    assert.equal(text(r), 'bitbucket.list_pull_requests({"q":"1"})');
  });

  await step("expired access token → silent refresh", async () => {
    jira.expireAccess();
    const r = await client.callTool({ name: "add_worklog", arguments: {} });
    assert.equal(text(r), "jira.add_worklog({})");
    assert.equal(jira.stats.refreshes, 1);
    assert.equal(gateway.services[0].state, "connected");
  });

  await step("downstream session lost (404) → reconnect + retry", async () => {
    jira.dropSessions();
    const r = await client.callTool({ name: "search", arguments: {} });
    assert.equal(text(r), "jira.search({})");
  });

  await step("revoked tokens → pending_auth with link in error, others keep working", async () => {
    jira.revokeAll();
    const r = (await client.callTool({ name: "search", arguments: {} })) as CallToolResult;
    assert.equal(r.isError, true);
    assert.match(text(r), /requires re-authorization[\s\S]*http:\/\/127\.0\.0\.1:4101\/authorize/);
    const url1 = gateway.services[0].authUrl;
    const again = (await client.callTool({ name: "search", arguments: {} })) as CallToolResult;
    assert.equal(gateway.services[0].authUrl, url1, "same URL during pending period");
    assert.equal(again.isError, true);
    const other = await client.callTool({ name: "confluence_search", arguments: {} });
    assert.equal(text(other), "confluence.search({})");
  });

  await step("re-authorization restores the service", async () => {
    const before = listChanged;
    await authorize(gateway.services[0].authUrl!);
    await until(() => gateway.services[0].state === "connected", "jira reconnected");
    await until(() => listChanged > before, "list_changed after re-auth");
    const r = await client.callTool({ name: "search", arguments: {} });
    assert.equal(text(r), "jira.search({})");
  });

  await step("downstream list_changed propagates", async () => {
    const before = listChanged;
    jira.setTools(["search", "add_worklog", "transition"]);
    await until(() => listChanged > before, "propagated list_changed");
    await until(() => gateway.registry.get("transition") !== undefined, "registry refresh");
    assert.ok((await toolNames()).includes("transition"));
  });

  await step("DNS rebinding protection: foreign Host / Origin → 403", async () => {
    const status = (headers: Record<string, string>) =>
      new Promise<number>((resolve) => {
        http
          .request({ host: "127.0.0.1", port: PORT, path: "/mcp", method: "POST", headers }, (res) => resolve(res.statusCode!))
          .end("{}");
      });
    assert.equal(await status({ Host: "evil.com" }), 403);
    assert.equal(await status({ Host: `127.0.0.1:${PORT}`, Origin: "http://evil.com" }), 403);
  });

  await step("unknown session id → 404", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": "nope" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 404);
  });

  await step("CLI list / get against running gateway", async () => {
    await main(["list"]);
    await main(["get", "jira"]);
    const st = gateway.status();
    assert.equal(st.services.find((s) => s.name === "jira")!.activeInSessions, 1);
  });

  await step("restart: tokens persisted, no new authorization", async () => {
    await client.close();
    await gateway.close();
    const auths = mocks.map((m) => m.stats.authorizations);
    gateway = await startGateway();
    assert.deepEqual(gateway.services.map((s) => s.state), ["connected", "connected", "connected"]);
    assert.deepEqual(mocks.map((m) => m.stats.authorizations), auths);
    await connectClient();
    assert.deepEqual(await toolNames(), ["gateway_call", "gateway_info"], "new session starts with no active scopes");
  });

  await step("eager service visible without activation", async () => {
    await client.close();
    await gateway.close();
    const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    cfg.services.confluence.eager = true;
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(cfg));
    gateway = await startGateway();
    await connectClient();
    assert.deepEqual(await toolNames(), ["confluence_get_page", "confluence_search", "gateway_call", "gateway_info"]);
  });

  await step("CLI add / remove", async () => {
    await main(["add", "extra", "https://example.com/mcp", "--prefix", "x_"]);
    let cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    assert.deepEqual(cfg.services.extra, { url: "https://example.com/mcp", toolPrefix: "x_" });
    await assert.rejects(main(["add", "extra", "https://example.com/mcp"]), /already exists/);
    await main(["remove", "extra"]);
    cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    assert.equal(cfg.services.extra, undefined);
    await assert.rejects(main(["remove", "extra"]), /not found/);
  });

  await step("no DCR on auth server → error with clientId hint; static clientId works", async () => {
    const { DownstreamService } = await import("../src/downstreams/service.js");
    const noDcr = await startMock({ port: 4104, name: "nodcr", tools: ["ping"], dcr: false });
    mocks.push(noDcr);
    const bad = new DownstreamService("nodcr", { url: noDcr.url });
    await bad.start();
    assert.equal(bad.state, "error");
    assert.match(bad.lastError!, /set "clientId"/);
    await bad.stop();

    const good = new DownstreamService("nodcr", { url: noDcr.url, clientId: "static-client" });
    await good.start();
    assert.equal(good.state, "pending_auth");
    assert.match(good.authUrl!, /client_id=static-client/);
    await authorize(good.authUrl!);
    await until(() => good.state === "connected", "static client connected");
    await good.stop();
  });

  console.log(`\n✅ ${passed} steps passed`);
} finally {
  await client!?.close().catch(() => {});
  await gateway.close().catch(() => {});
  for (const m of mocks) await m.close();
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(0);
