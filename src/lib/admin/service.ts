import type { Database } from "../history/database.ts";
import { sessionAccount } from "../accounts/store.ts";
import { adminOwnerConfig, isAdminOwner, type AdminOwner } from "./owner.ts";
import { queryAdminReport, type OwnerAdminReport } from "./query.ts";

export type AdminResult = { status: "denied" } | { status: "unavailable" } | { status: "ok"; report: OwnerAdminReport };
export type AdminDependencies = { token: () => Promise<string | null>; database: () => Promise<Database | null>; owner?: () => AdminOwner | null };
export function createOwnerAdminService(dependencies: AdminDependencies) {
  return async (page=1): Promise<AdminResult> => {
    const owner = (dependencies.owner ?? adminOwnerConfig)();
    if (!owner) return {status:"denied"};
    const token = await dependencies.token();
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return {status:"denied"};
    let authorised = false;
    try {
      const database=await dependencies.database();
      if (!database) return {status:"denied"};
      return await database.transaction(async sql => {
        await sql.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
        const account=await sessionAccount({...sql,transaction:operation=>operation(sql),close:async()=>{}},token);
        if (!isAdminOwner(account,owner)) return {status:"denied"};
        authorised=true;
        return {status:"ok",report:await queryAdminReport(sql,page)};
      });
    } catch { return {status:authorised ? "unavailable" : "denied"}; }
  };
}
