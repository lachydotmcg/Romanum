// Log only known diagnostic categories. Driver messages, stacks, queries and
// connection strings can contain credentials or private data and must stay out.
const categories: Record<string, string> = {
  ERR_INVALID_URL: "invalid_database_url",
  ENOENT: "certificate_file_missing",
  ENOTFOUND: "database_dns_failed",
  ECONNREFUSED: "database_connection_refused",
  ETIMEDOUT: "database_connection_timeout",
  ECONNRESET: "database_connection_reset",
  DEPTH_ZERO_SELF_SIGNED_CERT: "database_certificate_untrusted",
  SELF_SIGNED_CERT_IN_CHAIN: "database_certificate_untrusted",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "database_certificate_untrusted",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "database_certificate_untrusted",
  ERR_TLS_CERT_ALTNAME_INVALID: "database_certificate_hostname_mismatch",
  CERT_HAS_EXPIRED: "database_certificate_expired",
  "28P01": "database_password_rejected",
  "28000": "database_access_rejected",
  "3D000": "database_name_missing",
  "42P01": "database_migrations_missing",
  "53300": "database_connection_limit",
};

export function databaseFailureCategory(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  return typeof code === "string" && Object.hasOwn(categories, code) ? categories[code] : "database_operation_failed";
}

export function reportDatabaseFailure(error: unknown) {
  console.error("Romanum database:", databaseFailureCategory(error));
}
