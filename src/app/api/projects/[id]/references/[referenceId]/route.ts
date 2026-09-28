import { readAccount } from "@/lib/accounts/session";
import { historyDatabase } from "@/lib/history/database";
import { referenceResponse } from "@/lib/projects/reference-http";
import { requestOrigin } from "@/lib/turnstile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const deps = { account: readAccount, database: historyDatabase, origin: requestOrigin };
type Context = { params: Promise<{ id: string; referenceId: string }> };
export async function GET(request: Request, context: Context) {
  const { id, referenceId } = await context.params;
  return referenceResponse(request, deps, id, referenceId);
}
export const DELETE = GET;
