import type { Database } from "../history/database.ts";
import { readProjectPlan } from "./plans.ts";
import { planMarkdown } from "./plan-export.ts";

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
export async function planResponse(request: Request, deps: { account: () => Promise<{ ownerId: string } | null>; database: () => Promise<Database | null> }, projectId: string, planId: string) {
  const account = await deps.account();
  if (!account) return Response.json({ error: "Sign in to view plans." }, { status: 401, headers });
  try {
    const db = await deps.database();
    if (!db) throw new Error("Unavailable");
    const plan = await readProjectPlan(db, account.ownerId, projectId, planId);
    if (!plan) return Response.json({ error: "Plan not found." }, { status: 404, headers });
    if (new URL(request.url).searchParams.get("download") === "markdown") return new Response(planMarkdown(plan), { headers: { ...headers, "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="romanum-plan-${plan.id}.md"` } });
    return Response.json({ plan }, { headers });
  } catch {
    return Response.json({ error: "Plans unavailable. Try again later." }, { status: 503, headers });
  }
}
