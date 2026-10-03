import type { AdapterErrorCode, ProviderFailureCauseClass, ProviderFailureDiagnostic,
  ProviderFailurePhase, ProviderTransportCode } from "./types.ts";

const transportClasses: Readonly<Record<ProviderTransportCode, ProviderFailureCauseClass>> = Object.freeze({
  ENOTFOUND: "dns", EAI_AGAIN: "dns",
  ECONNREFUSED: "connect", ENETUNREACH: "connect", EHOSTUNREACH: "connect", UND_ERR_CONNECT_TIMEOUT: "connect",
  ERR_TLS_CERT_ALTNAME_INVALID: "tls", CERT_HAS_EXPIRED: "tls", CERT_NOT_YET_VALID: "tls",
  DEPTH_ZERO_SELF_SIGNED_CERT: "tls", SELF_SIGNED_CERT_IN_CHAIN: "tls", UNABLE_TO_VERIFY_LEAF_SIGNATURE: "tls",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "tls", ERR_SSL_WRONG_VERSION_NUMBER: "tls",
  ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE: "tls", ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION: "tls",
  ECONNRESET: "connection_reset", EPIPE: "connection_reset", UND_ERR_SOCKET: "connection_reset",
  ETIMEDOUT: "transport_timeout", UND_ERR_HEADERS_TIMEOUT: "transport_timeout", UND_ERR_BODY_TIMEOUT: "transport_timeout",
  ABORT_ERR: "aborted",
});
const domExceptionName = typeof DOMException === "undefined" ? undefined
  : Object.getOwnPropertyDescriptor(DOMException.prototype, "name")?.get;

function ownData(value: object, key: "code" | "cause"): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}

/** Project a bounded cause chain onto fixed enums. Never read arbitrary error getters or text.
 * Fetch itself cannot prove the precise wire phase, submission outcome or provider bill. */
export function providerFailureDiagnostic(error: unknown, phase: ProviderFailurePhase,
  code: AdapterErrorCode): ProviderFailureDiagnostic {
  const fixed = (causeClass: ProviderFailureCauseClass) => Object.freeze({ phase, causeClass });
  if (code === "cancelled") return fixed("aborted");
  if (code === "timeout") return fixed("deadline");
  if (code === "provider_unavailable" || code === "provider_busy" || code === "provider_error") return fixed("provider_status");
  if (code === "consumer_error") return fixed("consumer");
  if (code !== "network_error") return fixed("adapter_rejected");

  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object" && !seen.has(current); depth++) {
    seen.add(current);
    const candidate = ownData(current, "code");
    if (typeof candidate === "string" && Object.prototype.hasOwnProperty.call(transportClasses, candidate)) {
      const transportCode = candidate as ProviderTransportCode;
      return Object.freeze({ phase, causeClass: transportClasses[transportCode], transportCode });
    }
    // The native getter performs a brand check; a forged error.name is never consulted.
    try {
      const name: unknown = domExceptionName?.call(current);
      if (name === "AbortError") return fixed("aborted");
      if (name === "TimeoutError") return fixed("transport_timeout");
    } catch { /* Not a genuine DOMException. */ }
    current = ownData(current, "cause");
  }
  return fixed("unknown");
}
