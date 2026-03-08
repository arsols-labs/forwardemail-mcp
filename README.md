# forwardemail-mcp

`forwardemail-mcp` is an MCP server for Forward Email workflows. It exposes mail, calendar, and contacts tools over local `stdio` for development and Streamable HTTP for remote clients such as Notion Custom Agents.

The default configuration targets the public Forward Email service. If you run a self-hosted setup, override the service URLs in your environment.

Versioning:

- Releases use semver tags and GitHub Releases.
- The first public release target is `v0.1.0`.

Auth model:

- `FE_ALIAS_USER` + `FE_ALIAS_PASS` + DAV URLs power mailbox, calendar, and contacts tools.
- `FE_API_KEY` is used for API-key-only actions such as sending mail.
- `MCP_AUTH_TOKEN` protects the public `/mcp` endpoint when you deploy remotely.

## What It Does

- Read and search inbox messages with bounded metadata responses.
- Read individual messages and list folders.
- Send mail through the provider API.
- List, create, update, and delete calendar events.
- List, search, read, and create contacts.

## Local Stdio Quickstart

1. To pin the first public release once tags are available:

```bash
git checkout v0.1.0
```

2. Install dependencies:

```bash
npm install
```

3. Create local config from the example and fill in real values:

```bash
cp .env.example .env
```

4. Build the server:

```bash
npm run build
```

5. Point your MCP client at the built entrypoint. Example:

```json
{
  "mcpServers": {
    "forwardemail": {
      "command": "node",
      "args": ["/absolute/path/to/forwardemail-mcp/dist/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "LOG_LEVEL": "info",
        "FE_API_URL": "https://api.forwardemail.net",
        "FE_API_KEY": "replace-with-api-key",
        "FE_CALDAV_URL": "https://caldav.forwardemail.net",
        "FE_CARDDAV_URL": "https://carddav.forwardemail.net",
        "FE_ALIAS_USER": "alias@example.com",
        "FE_ALIAS_PASS": "replace-with-alias-password"
      }
    }
  }
}
```

`MCP_TRANSPORT=stdio` is the default, so `npm run dev` also works for local iteration.

## Optional: 1Password SDK Mode

The runtime also supports resolving secrets directly from 1Password via the 1Password SDK.

1. Set `AUTH_MODE=1password-sdk`.
2. Export `OP_SERVICE_ACCOUNT_TOKEN`.
3. Replace credential values with `op://vault/item/field` or `op://vault/item/section/field` references.

Example:

```dotenv
AUTH_MODE=1password-sdk
OP_SERVICE_ACCOUNT_TOKEN=ops_xxx
FE_API_URL=op://vault/forwardemail/api-url
FE_API_KEY=op://vault/forwardemail/api-key
FE_CALDAV_URL=op://vault/forwardemail/caldav-url
FE_CARDDAV_URL=op://vault/forwardemail/carddav-url
FE_ALIAS_USER=op://vault/forwardemail/alias-user
FE_ALIAS_PASS=op://vault/forwardemail/alias-pass
```

If `AUTH_MODE=env`, the server reads the plain environment variables instead.

## Cloudflare Workers Deploy

1. Build the worker bundle:

```bash
npm run build
```

2. Set worker secrets:

```bash
wrangler secret put FE_API_URL
wrangler secret put FE_API_KEY
wrangler secret put FE_CALDAV_URL
wrangler secret put FE_CARDDAV_URL
wrangler secret put FE_ALIAS_USER
wrangler secret put FE_ALIAS_PASS
wrangler secret put MCP_AUTH_TOKEN
```

3. Deploy:

```bash
npm run cf:deploy
```

4. Use the deployed MCP endpoint at your worker URL plus `/mcp`. `GET /health` can stay public; `/mcp` should stay behind a bearer token.

## Connect to Notion Custom Agent

As of March 8, 2026, Notion documents custom MCP connections for Custom Agents on Business and Enterprise plans only, with workspace-admin enablement for custom MCP servers.

1. Ask a workspace admin to enable custom MCP servers in `Settings -> Notion AI -> AI connectors`.
2. Open the Custom Agent, then go to `Settings -> Tools & Access`.
3. Choose `Add connection -> Custom MCP server`.
4. Paste your public MCP URL ending in `/mcp`.
5. Set any display name you want.
6. Add header-based auth:

```text
Authorization: Bearer <MCP_AUTH_TOKEN>
```

7. Save the connection, then enable the tools you want.
8. Keep write tools on `Always ask` unless you explicitly want automatic writes.

Each Custom Agent needs its own MCP connection.

## Troubleshooting

- `401 Unauthorized`: the bearer token sent by the client does not match `MCP_AUTH_TOKEN`.
- `404 Not found`: use the `/mcp` path for MCP traffic, not the worker root URL.
- No tools show up in Notion: refresh the agent settings page, confirm the server is reachable, and reconnect if needed.
- Calendar or contacts fail: verify `FE_ALIAS_USER`, `FE_ALIAS_PASS`, `FE_CALDAV_URL`, and `FE_CARDDAV_URL`.
- Mail search feels too large: `email_list_inbox` and `email_search` intentionally clamp results and return metadata-only summaries.
