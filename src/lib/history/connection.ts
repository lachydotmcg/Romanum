import { readFileSync } from "node:fs";
import path from "node:path";
import type { PoolConfig } from "pg";

/** Heroku Essential uses RDS certificates, which aren't in Node's default CA store.
 * Public trust bundle: https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
 * Keep this public certificate file in server bundles; never bundle .local credentials.
 */
export function connectionOptions(connectionString: string): PoolConfig {
  const url = new URL(connectionString);
  if (!url.hostname.endsWith(".rds.amazonaws.com")) return { connectionString };
  // pg's URL SSL parameters override its ssl object. Remove them so neither a
  // local certificate path nor sslmode=no-verify can weaken the hosted connection.
  for (const key of ["ssl", "sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"]) url.searchParams.delete(key);
  return {
    connectionString: url.href,
    ssl: {
      ca: readFileSync(path.join(process.cwd(), "src/lib/history/certs/aws-rds-global.pem"), "utf8"),
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    },
  };
}
