const PUBLIC_MCP_URL = "https://romanum.dev/mcp";
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

// Hosted connection pages advertise the documented canonical endpoint. This only
// selects a displayed URL; the endpoint's host and origin policy remains separate.
export function mcpConnection(origin: string): { url: string; local: boolean } {
  try {
    const parsed = new URL(origin);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username && !parsed.password && LOOPBACK_HOSTS.includes(parsed.hostname)) {
      return { url: new URL("/mcp", parsed).href, local: true };
    }
  } catch { /* Server rendering and malformed origins use the canonical URL. */ }
  return { url: PUBLIC_MCP_URL, local: false };
}
