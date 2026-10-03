import type { Sql } from "../history/database.ts";
import { RELEASED_EXECUTION_REVIEWS } from "./readiness.ts";
import type { ExecutionReviews } from "./types.ts";

/** Check the same search path and role used by wallet operations. No wallet mutation. */
export async function providerAccountingAvailable(database: Sql | null): Promise<boolean> {
  if (!database) return false;
  try {
    const { rows } = await database.query<{ ready: boolean }>(`SELECT count(*) = 2 AND bool_and(
      has_table_privilege(to_regclass(name), 'SELECT') AND
      has_table_privilege(to_regclass(name), 'INSERT') AND
      has_table_privilege(to_regclass(name), 'UPDATE')) AS ready
      FROM (VALUES ('provider_attempts'), ('provider_final_claims')) AS required(name)
      WHERE to_regclass(name) IS NOT NULL`);
    return rows.length === 1 && rows[0].ready === true;
  } catch { return false; }
}

/** Schema outages affect only the native adapters that require migration 023. */
export async function runtimeExecutionReviews(database: Sql | null): Promise<Readonly<ExecutionReviews>> {
  if (await providerAccountingAvailable(database)) return RELEASED_EXECUTION_REVIEWS;
  return Object.fromEntries(Object.entries(RELEASED_EXECUTION_REVIEWS).map(([id, review]) => [id,
    id === "deepseek-flash" ? review : { ...review, executionEnabled: false },
  ]));
}
