import { readAccount } from "@/lib/accounts/session";
import { historyDatabase } from "@/lib/history/database";
import { planResponse } from "@/lib/projects/plan-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string; planId: string }> }) {
  const { id, planId } = await params;
  return planResponse(request, { account: readAccount, database: historyDatabase }, id, planId);
}
