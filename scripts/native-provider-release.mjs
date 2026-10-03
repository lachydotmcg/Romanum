import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { postgresDatabase } from "../src/lib/history/database.ts";
import { migrateHistory } from "../src/lib/history/migrate.ts";
import { providerAccountingAvailable } from "../src/lib/models/provider-schema.ts";

// One explicitly authorized release prerequisite, invoked by its temporary build
// command. It is not part of npm build or an automatic future migration policy.
const SITE_ID = "da1614d6-1173-4d1b-9064-e829e1c70807";
const TARGET = "a066f1e369e195987e5c0773a9311d84a7ed78c37b8b2d745c540d1adcc74bd4";
const ROLE = "47c6715113831f84afc28425b9fe3cf12865e798ecbb362283148b98c27ab888";
export function checkReleaseEnvironment(environment, release) {
  assert.match(release ?? "", /^[a-f0-9]{40}$/);
  assert.equal(environment.NETLIFY, "true");
  assert.equal(environment.SITE_ID, SITE_ID);
  assert.equal(environment.CONTEXT, "production");
  assert.equal(environment.BRANCH, "main");
  assert.equal(environment.COMMIT_REF, release);
  const target = new URL(environment.DATABASE_URL);
  assert.ok(["postgres:", "postgresql:"].includes(target.protocol));
  const fingerprint = createHash("sha256").update(`${target.hostname}:${target.port || 5432}${target.pathname}`).digest("hex");
  assert.equal(fingerprint, TARGET);
  return fingerprint;
}

export async function applyNativeProviderPrerequisite(database, directory = path.join(process.cwd(), "db", "migrations"), expectedRole = ROLE) {
  const files = (await readdir(directory)).filter(file => /^\d{3}_[a-z0-9_]+\.sql$/.test(file)).sort();
  assert.equal(files.length, 23);
  assert.equal(files.at(-1), "023_provider_attempts.sql");
  const checksums = await Promise.all(files.map(async (file, index) => {
    assert.equal(Number(file.slice(0, 3)), index + 1);
    return createHash("sha256").update((await readFile(path.join(directory, file), "utf8")).replaceAll("\r\n", "\n")).digest("hex");
  }));
  await database.transaction(async sql => {
    await sql.exec("SET TRANSACTION READ ONLY");
    const identity = (await sql.query(`SELECT current_user AS role, current_database() AS database, current_schema() AS schema,
      has_database_privilege(current_database(),'CONNECT') AS connect,
      has_schema_privilege('public','USAGE') AS usage,
      has_schema_privilege('public','CREATE') AS create`)).rows[0];
    assert.equal(createHash("sha256").update(`${identity.role}:${identity.database}`).digest("hex"), expectedRole);
    assert.equal(identity.schema, "public");
    assert.ok(identity.connect && identity.usage && identity.create);
    const { rows } = await sql.query("SELECT version, checksum FROM public.romanum_migrations ORDER BY version");
    assert.ok(rows.length === 22 || rows.length === 23);
    for (const [index, row] of rows.entries()) {
      assert.equal(row.version, index + 1);
      assert.equal(row.checksum, checksums[index]);
    }
    const privileges = (await sql.query(`SELECT
      has_table_privilege('public.romanum_migrations','SELECT') AND
      has_table_privilege('public.romanum_migrations','INSERT') AND
      has_table_privilege('public.romanum_migrations','UPDATE') AS migration,
      has_column_privilege('public.credits_accounts','owner_id','REFERENCES') AND
      has_column_privilege('public.usage_holds','id','REFERENCES') AND
      has_column_privilege('public.usage_charges','id','REFERENCES') AS references,
      bool_and(has_table_privilege(name,'SELECT') AND has_table_privilege(name,'INSERT') AND
        has_table_privilege(name,'UPDATE')) AS wallet
      FROM (VALUES ('public.credits_accounts'), ('public.credits_operations'), ('public.usage_carry'),
        ('public.usage_holds'), ('public.usage_charges')) AS required(name)`)).rows[0];
    assert.ok(privileges.migration && privileges.references && privileges.wallet);
  });
  // The normal runner checks all checksums again under its exclusive lock.
  await migrateHistory(database);
  assert.equal(await providerAccountingAvailable(database), true);
  const { rows } = await database.query("SELECT version, checksum FROM public.romanum_migrations ORDER BY version");
  assert.equal(rows.length, 23);
  assert.equal(rows[22].checksum, checksums[22]);
  return { targetVerified: true, roleVerified: true, migration023: "applied", accountingAvailable: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let database;
  try {
    checkReleaseEnvironment(process.env, process.argv[2]);
    database = postgresDatabase(process.env.DATABASE_URL);
    const result = await applyNativeProviderPrerequisite(database);
    console.log(JSON.stringify({ nativeProviderRelease: result, commit: process.env.COMMIT_REF }));
  } catch {
    // Assertions, URLs and driver errors can contain credentials or host metadata.
    console.error("Native provider release prerequisite failed. Production was not published by this command.");
    process.exitCode = 1;
  } finally { await database?.close(); }
}
