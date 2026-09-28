import { projectResponse } from "@/lib/projects/http";
import { readAccount } from "@/lib/accounts/session";
import { historyDatabase } from "@/lib/history/database";
import { isCrossSite } from "@/lib/guest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const deps = { account: readAccount, database: historyDatabase, isCrossSite };
export const GET = (request: Request) => projectResponse(request, deps);
export const POST = (request: Request) => projectResponse(request, deps);
