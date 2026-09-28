import { readAccount } from "@/lib/accounts/session";
import { accountExportResponse } from "@/lib/accounts/export-http";
import { historyDatabase } from "@/lib/history/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => accountExportResponse(request, { account: readAccount, database: historyDatabase });
