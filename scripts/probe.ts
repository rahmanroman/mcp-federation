/**
 * Phase 0 probe: checks OAuth assumptions of downstream MCP servers.
 *   npm run probe -- <url> [<url>...]      (or: all services from config.json when no url given)
 */
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { loadConfig } from "../src/config.js";
import { CALLBACK_URL } from "../src/paths.js";

const ok = (s: string) => console.log(`  ✓ ${s}`);
const bad = (s: string) => console.log(`  ✗ ${s}`);
const info = (s: string) => console.log(`  · ${s}`);

async function probe(label: string, url: string): Promise<void> {
  console.log(`\n[${label}] ${url}`);

  // 1. Unauthenticated request → expect 401 + WWW-Authenticate
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } } }),
    });
    info(`unauthenticated initialize → HTTP ${res.status}`);
    const wwwAuth = res.headers.get("www-authenticate");
    if (wwwAuth) info(`WWW-Authenticate: ${wwwAuth}`);
  } catch (e: any) {
    bad(`server unreachable: ${e.message} ${e.cause?.code ?? ""}`);
    return;
  }

  // 2. Protected resource metadata (RFC 9728)
  let authServer: string | URL = new URL("/", url);
  try {
    const prm = await discoverOAuthProtectedResourceMetadata(url);
    ok(`protected resource metadata found`);
    if (prm.authorization_servers?.[0]) authServer = prm.authorization_servers[0];
    info(`authorization server: ${authServer}`);
    if (prm.scopes_supported) info(`resource scopes_supported: ${prm.scopes_supported.join(" ")}`);
  } catch (e: any) {
    info(`no protected resource metadata (${e.message}) — falling back to ${authServer}`);
  }

  // 3. Authorization server metadata (RFC 8414 / OIDC)
  const as = await discoverAuthorizationServerMetadata(authServer).catch(() => undefined);
  if (!as) {
    bad(`authorization server metadata not found`);
    return;
  }
  ok(`authorization server metadata found`);
  as.registration_endpoint
    ? ok(`DCR supported: ${as.registration_endpoint}`)
    : bad(`DCR NOT supported — a static "clientId" is required in config.json`);

  const pkce = as.code_challenge_methods_supported;
  pkce?.includes("S256") ? ok("PKCE S256 supported") : bad(`PKCE S256 not advertised (${pkce?.join(",") ?? "none"})`);

  const grants = as.grant_types_supported;
  if (!grants || grants.includes("refresh_token")) ok(`refresh_token grant ${grants ? "supported" : "(grant_types_supported not advertised)"}`);
  else bad(`refresh_token grant NOT supported — re-authorization required on every token expiry`);

  const scopes = as.scopes_supported;
  if (scopes) {
    info(`scopes_supported: ${scopes.join(" ")}`);
    scopes.includes("offline_access") ? ok("offline_access scope supported") : info("offline_access not listed — check refresh token issuance manually");
  }

  // 4. DCR dry-run: register a client to see if the redirect_uri is accepted
  if (as.registration_endpoint && process.argv.includes("--register")) {
    const res = await fetch(as.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "mcp-federation-probe",
        redirect_uris: [CALLBACK_URL],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    res.ok ? ok(`DCR accepted redirect_uri ${CALLBACK_URL}`) : bad(`DCR rejected: HTTP ${res.status} ${await res.text()}`);
  } else if (as.registration_endpoint) {
    info(`run with --register to test DCR with redirect_uri ${CALLBACK_URL} (creates a client)`);
  }
}

const urls = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const targets: [string, string][] = urls.length
  ? urls.map((u) => [u, u])
  : Object.entries(loadConfig().services).map(([n, s]) => [n, s.url]);

if (targets.length === 0) {
  console.log("Usage: npm run probe -- <url> [<url>...] [--register]   (or configure services first)");
  process.exit(1);
}
for (const [label, url] of targets) await probe(label, url);
