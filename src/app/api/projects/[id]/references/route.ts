import { readAccount } from "@/lib/accounts/session";
import { historyDatabase } from "@/lib/history/database";
import { referenceResponse } from "@/lib/projects/reference-http";
import { requestOrigin } from "@/lib/turnstile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const deps = { account: readAccount, database: historyDatabase, origin: requestOrigin };
type Context = { params: Promise<{ id: string }> };
export const GET = async (request: Request, context: Context) => referenceResponse(request, deps, (await context.params).id);
export const POST = GET;
