// Server-only Turnstile validation. Never trust a browser callback without Siteverify.
// https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
export type TurnstileAction = "guest" | "roblox_signin";
type Environment = Record<string, string | undefined>;
export const TURNSTILE_HEADER = "x-turnstile-token";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const TEST_SITE = /^[123]x0+(AA|AB|BB|FF)$/;
const TEST_SECRET = /^[123]x0+AA$/;

/** Next may use its bind address in request.url; Host is still checked against the configured allowlist. */
export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  if (host) url.host = host;
  return url.origin;
}

export class VerificationError extends Error {
  readonly action: TurnstileAction;
  readonly siteKey: string | null;
  readonly unavailable: boolean;
  constructor(action: TurnstileAction, siteKey: string | null, unavailable = false) {
    super(unavailable ? "Verification unavailable. Try again later." : "Verify to continue.");
    this.name = "VerificationError";
    this.action = action;
    this.siteKey = siteKey;
    this.unavailable = unavailable;
  }
}

export function turnstileConfig(requestUrl: string, env: Environment = process.env) {
  const siteKey = env.TURNSTILE_SITE_KEY?.trim();
  const secretKey = env.TURNSTILE_SECRET_KEY?.trim();
  const hostname = new URL(requestUrl).hostname.toLowerCase();
  if (!siteKey || !secretKey) return null;
  const test = TEST_SITE.test(siteKey) || TEST_SECRET.test(secretKey);
  if (test) {
    // Dummy keys are deliberately restricted to local development, even if copied into deployment settings.
    if (env.NODE_ENV === "production" || !LOCAL_HOSTS.has(hostname) || !TEST_SITE.test(siteKey) || !TEST_SECRET.test(secretKey)) return null;
  }
  const hostnames = (env.TURNSTILE_ALLOWED_HOSTNAMES ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (!test && (!hostnames.length || !hostnames.includes(hostname))) return null;
  return { siteKey, secretKey, hostname, test };
}

/** Fails closed for missing keys, wrong hosts/actions, expired/replayed tokens and provider failures. */
export async function verifyTurnstile(
  request: Request,
  action: TurnstileAction,
  options: { env?: Environment; fetch?: typeof fetch } = {},
): Promise<void> {
  const config = turnstileConfig(requestOrigin(request), options.env);
  if (!config) throw new VerificationError(action, null, true);
  const token = request.headers.get(TURNSTILE_HEADER);
  if (!token || token.length > 2048) throw new VerificationError(action, config.siteKey);
  let result: unknown;
  try {
    const response = await (options.fetch ?? fetch)("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: config.secretKey, response: token }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Siteverify unavailable");
    result = await response.json();
  } catch {
    // Do not log tokens, secrets or the provider's raw response.
    throw new VerificationError(action, config.siteKey, true);
  }
  const data = result as { success?: unknown; hostname?: unknown; action?: unknown } | null;
  // Official dummy tokens don't retain the widget's action or hostname. Only local test mode permits this.
  if (data?.success !== true || (!config.test && (data.hostname !== config.hostname || data.action !== action))) {
    throw new VerificationError(action, config.siteKey);
  }
}

export function verificationResponse(error: unknown): Response | null {
  if (!(error instanceof VerificationError)) return null;
  return Response.json({
    error: error.message,
    code: error.unavailable ? "verification_unavailable" : "verification_required",
    action: error.action,
    siteKey: error.siteKey,
  }, { status: error.unavailable ? 503 : 403, headers: { "Cache-Control": "no-store" } });
}
