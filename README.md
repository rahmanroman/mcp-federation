# mcp-federation

Local MCP gateway that federates multiple OAuth-protected HTTP MCP servers (Jira, Bitbucket, Confluence, …) behind a single Streamable HTTP endpoint.

- One place to authorize: OAuth 2.1 (PKCE + Dynamic Client Registration, static `clientId` fallback), silent refresh, re-authorization without restart
- Lazy tool loading: a session sees only `gateway_info` until a service is activated
- Works with any MCP client that speaks Streamable HTTP

## Quick start

```sh
git clone git@github.com:rahmanroman/mcp-federation.git
cd mcp-federation
npm install
npm link            # builds and installs the global `mcp-federation` command

mcp-federation add jira https://mcp.corp.example.com/jira/mcp
mcp-federation start
```

Update: `git pull && npm install` (rebuilds `dist/`; the link stays). Uninstall: `npm unlink -g mcp-federation`.

Point your MCP client at `http://127.0.0.1:3117/mcp`. For Claude Code:

```sh
claude mcp add --transport http mcp-federation http://127.0.0.1:3117/mcp
```

## CLI

```
mcp-federation start [-p | --port <n>] [--notify]
mcp-federation add <name> <url> [--prefix <p>]
mcp-federation remove <name>
mcp-federation list
mcp-federation get <name>
```

## Config — `~/.mcp-federation/config.json`

```json
{
  "port": 3117,
  "notify": false,
  "lazy": true,
  "services": {
    "jira": { "url": "https://mcp.corp.example.com/jira/mcp" },
    "confluence": {
      "url": "https://mcp.corp.example.com/confluence/mcp",
      "toolPrefix": "confluence_",
      "eager": true,
      "scope": "read write offline_access",
      "clientId": "only-if-no-DCR"
    }
  }
}
```

Services listed earlier win tool name collisions; use `toolPrefix` to avoid them. `eager` exposes a service's tools without activation (for clients that ignore `tools/list_changed`).

## Development

```sh
npm test                               # end-to-end test against mock OAuth-protected servers
npm run probe -- <url> [--register]    # check a server's OAuth capabilities (DCR, PKCE, refresh)
```
