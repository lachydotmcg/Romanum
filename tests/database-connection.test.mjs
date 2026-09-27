import test from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { connectionOptions } from "../src/lib/history/connection.ts";
import { databaseFailureCategory } from "../src/lib/history/diagnostics.ts";

test("database diagnostics identify known failures without exposing arbitrary driver content", () => {
  assert.equal(databaseFailureCategory({ code: "ENOENT", path: "private-path" }), "certificate_file_missing");
  assert.equal(databaseFailureCategory({ code: "28P01", message: "private-password" }), "database_password_rejected");
  for (const value of [null, "private-password", { code: "private-password" }, { code: "__proto__" }, new Error("postgres://private-password")]) {
    assert.equal(databaseFailureCategory(value), "database_operation_failed");
  }
});

test("Heroku RDS uses bundled certificates and cannot disable verification via URL", () => {
  const options = connectionOptions("postgres://user:password@database.example.us-east-1.rds.amazonaws.com/app?sslmode=no-verify&sslrootcert=C%3A%2Flocal.pem&application_name=romanum");
  assert.equal(options.ssl.rejectUnauthorized, true);
  assert.equal(options.ssl.minVersion, "TLSv1.2");
  const url = new URL(options.connectionString);
  assert.equal(url.searchParams.has("sslmode"), false);
  assert.equal(url.searchParams.has("sslrootcert"), false);
  assert.equal(url.searchParams.get("application_name"), "romanum");
  const certificates = options.ssl.ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  assert.ok(certificates.length > 0);
  for (const pem of certificates) assert.equal(new X509Certificate(pem).ca, true);
});

test("local and other providers retain their explicit connection settings", () => {
  for (const connectionString of ["postgres://localhost/romanum_local", "postgres://db.example.com/app?sslmode=verify-full", "postgres://fake.rds.amazonaws.com.example.com/app"]) {
    assert.deepEqual(connectionOptions(connectionString), { connectionString });
  }
});
