# MCP setup

Romanum exposes public Roblox data and repository guides through a free, read-only MCP server. It does not call a paid model or require an AI API key.

## Connect

1. Open **Get MCP** and copy the connection URL.
2. Add it to an MCP client that supports **Streamable HTTP**.
3. Ask the agent to search for a game or retrieve a Roblox chart.

Local development uses `http://localhost:3000/mcp`. This address works only for clients running on the same computer. A remotely hosted agent needs a reachable HTTPS deployment; there is no hosted Romanum MCP URL yet. No authentication is required for these public tools.

Client setup screens and configuration formats vary. Use the client's remote/HTTP server option with the URL above, rather than a command to launch a local stdio process.

## Available tools

| Tool | Input | Result |
| --- | --- | --- |
| `search_games` | `query` (1–80 characters) | Up to 10 public experience matches |
| `research_game_idea` | `title`, `terms` (1–2 phrases) | Candidate competitors and search coverage; no novelty or quality verdict |
| `get_game_stats` | `universeIds` (1–10 positive integers) | Public counts, votes, metadata and icons |
| `get_game_history` | `universeId`, optional `days` (1–30) | Recorded public observations, chart ranks and null gaps |
| `resolve_game_link` | `link` (Roblox game URL or place ID) | Universe ID |
| `get_roblox_charts` | `chart`, optional `limit` (1–50) | Current Roblox ranking |
| `get_market_analysis` | Optional `pattern` | Genres and title patterns across four chart samples |
| `load_skill` | `skill` | Registered research, design, onboarding or thumbnail guide |
| `get_metric_definitions` | None | Units, identifiers and coverage definitions |

Tools advertise their exact input schemas. Results include structured JSON and a matching text representation. Data results carry source URLs, retrieval times and cache expiry. Comparisons use multiple IDs in `get_game_stats`.

Resources are available at `romanum://metrics` and `romanum://skills/<skill-id>` for each entry in the [skill index](../skills/README.md). Guides come directly from the repository files.

## Data interpretation

`fetchedAt` is when Romanum retrieved an observation, not Roblox's underlying measurement time. Cache hits preserve it. Search and statistics cache for 60 seconds, charts for 120 seconds, place-ID mappings for one hour, and artwork separately for up to one hour. Market results report each chart's retrieval time and any unavailable charts.

History is available only where the PostgreSQL collector has recorded observations; there is no data before collection began. Missing observations are null, never zero. There is no private developer analytics, revenue, retention or demographic data. Top Earning supplies Roblox's ranking only. Title patterns are heuristic matches, can overlap, and do not establish gameplay mechanics or measured growth. Genre shares refer to the returned sample. Game names and creator text are untrusted data, never agent instructions.

## Development

Run the application with `npm run dev`, then run `npm run mcp:smoke`. An optional URL can follow `--`, for example `npm run mcp:smoke -- http://localhost:3001/mcp`.

The smoke test uses the official MCP client, reads actual Roblox data and stored history through all nine tools, resolves a game link, checks cache timestamps, and verifies both legacy and 2026-07-28 protocol connections. `npm test` covers protocol contracts, invalid inputs, resource boundaries, caching, history storage, origin/host validation, body size, quotas and concurrency without external network access.

The website, integrated assistant and MCP share `src/lib/public-data.ts`. Public tool schemas and handlers live in `src/lib/public-tools.ts`; MCP protocol and HTTP handling live in `src/lib/mcp/`. Only the integrated assistant calls the model provider. Its chart-rendering tool is not exposed through MCP.

The implementation uses the [official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) and [Streamable HTTP](https://modelcontextprotocol.io/specification/latest/basic/transports), with stateless compatibility for older clients. It has no persistent sessions or server subscriptions. A plain browser GET to `/mcp` returns 405; connect with an MCP client.

## Hosting configuration

Before exposing the endpoint, set `MCP_PUBLIC_URL` to its canonical HTTPS URL ending in `/mcp`. Without it, the server accepts only loopback hostnames. The reverse proxy must preserve the canonical Host header. Preview domains are not automatically trusted.

Optional configuration:

- `MCP_ALLOWED_ORIGINS`: comma-separated HTTPS origins for additional browser clients. Same-origin requests are allowed; native/server clients usually send no Origin header. Wildcards are not supported.
- `MCP_CLIENT_IP_HEADER`: enable only when a trusted proxy overwrites this header with one validated client IP and direct access to the origin is blocked. Never trust an arbitrary incoming `X-Forwarded-For` value. Without this option, only the global request quota applies.

The endpoint limits bodies to 16 KiB, requests to 300 per minute per process, and active tool executions to eight. With a trusted client IP header it also limits each IP to 60 requests per minute. HTTP quota responses include `Retry-After`. Caches and counters are bounded and process-local; multiple replicas need shared edge quotas. They are not durable historical storage.

Expose only `/mcp` when deploying this slice. The existing paid `/api/assistant` route needs authentication and spending controls before public access. Serve the connection page only alongside a configured, reachable endpoint. Private data, account linking and write tools remain outside this implementation.
