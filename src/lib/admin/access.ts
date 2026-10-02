/** Fixtures are reviewable locally; no account is authorised for live reporting yet. */
export function adminPreviewAllowed(environment: string | undefined, host: string, origin?: string | null) {
  if (environment !== "development" || /[@/\\?#\s]/.test(host)) return false;
  try {
    const url = new URL(`http://${host}`);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return false;
    return !origin || new URL(origin).origin === url.origin;
  } catch { return false; }
}

export function adminPreviewRequestAllowed(request: Request, environment = process.env.NODE_ENV) {
  const url = new URL(request.url);
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    && adminPreviewAllowed(environment, request.headers.get("host") ?? url.host, request.headers.get("origin"));
}
