import { cookies } from "next/headers";
import { historyDatabase } from "../history/database.ts";
import { SESSION_COOKIE } from "../accounts/session.ts";
import { createOwnerAdminService } from "./service.ts";

// Called by Server Components and route handlers only. No result is shared across requests.
export const ownerAdminReport = createOwnerAdminService({
  token:async()=>(await cookies()).get(SESSION_COOKIE)?.value ?? null,
  database:historyDatabase,
});
