import { readAccount } from "@/lib/accounts/session";
import { historyDatabase } from "@/lib/history/database";
import { requestOrigin } from "@/lib/turnstile";
import { privateStudioResponse, STUDIO_WORKFLOW_ENABLED } from "@/lib/agent-api-studio-workflow/private-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const deps = {
  enabled: STUDIO_WORKFLOW_ENABLED, account: readAccount, database: historyDatabase,
  origin: requestOrigin, workflow: async () => null,
};
type Context = { params: Promise<{ projectId: string }> };
export const GET = async (request: Request, context: Context) => privateStudioResponse(request, deps, (await context.params).projectId);
export const POST = GET;
