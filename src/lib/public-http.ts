import { publicData, type PublicDataService } from "./public-data.ts";
import { PUBLIC_TOOLS, runPublicTool } from "./public-tools.ts";
import { PUBLIC_DATA_CATALOG } from "./public-data-catalog.ts";

export type PublicHttpEndpoint = "stats" | "charts" | "market" | "catalog";

const TOOLS = {
  stats: "get_game_stats",
  charts: "get_roblox_charts",
  market: "get_market_analysis",
} as const;
const QUERY_KEYS: Record<PublicHttpEndpoint, readonly string[]> = {
  stats: ["universeIds"],
  charts: ["chart", "limit"],
  market: ["pattern"],
  catalog: [],
};
const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const MAX_URL_LENGTH = 2048;

function integer(value: string): number {
  if (!/^\d+$/.test(value.trim())) throw new Error("Invalid integer.");
  return Number(value.trim());
}

function queryInput(endpoint: PublicHttpEndpoint, request: Request) {
  if (request.url.length > MAX_URL_LENGTH) throw new Error("Query too long.");
  const query = new URL(request.url).searchParams;
  for (const key of query.keys()) {
    if (!QUERY_KEYS[endpoint].includes(key) || query.getAll(key).length !== 1) throw new Error("Invalid parameter.");
  }
  switch (endpoint) {
    case "stats":
      return { universeIds: (query.get("universeIds") ?? "").split(",").map(integer) };
    case "charts":
      return { chart: query.get("chart") ?? undefined, limit: query.has("limit") ? integer(query.get("limit")!) : undefined };
    case "market":
      return { pattern: query.get("pattern") ?? undefined };
    case "catalog":
      return {};
  }
}

/** Public observations only. The same tool schemas and service power MCP and these GET routes. */
export function createPublicHttpHandler(endpoint: PublicHttpEndpoint, service: PublicDataService = publicData) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET") {
      return Response.json({ error: "Use GET to read public data." }, { status: 405, headers: { ...HEADERS, Allow: "GET" } });
    }

    let input: unknown;
    try {
      input = queryInput(endpoint, request);
      if (endpoint !== "catalog") input = PUBLIC_TOOLS[TOOLS[endpoint]].schema.parse(input);
    } catch {
      return Response.json({ error: "Invalid query. Check /api/public/catalog for accepted parameters." }, { status: 400, headers: HEADERS });
    }

    if (endpoint === "catalog") return Response.json(PUBLIC_DATA_CATALOG, { headers: HEADERS });
    try {
      const { result } = await runPublicTool(TOOLS[endpoint], input, service);
      return Response.json(result, { headers: HEADERS });
    } catch {
      return Response.json({ error: "Couldn't retrieve public data. Try again." }, { status: 503, headers: HEADERS });
    }
  };
}
