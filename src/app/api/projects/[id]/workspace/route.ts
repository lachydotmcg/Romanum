import { readAccount } from "@/lib/accounts/session";
import { historyDatabase } from "@/lib/history/database";
import { readProject } from "@/lib/projects/store";
import { listProjectPlans } from "@/lib/projects/plans";
import { listProjectReferences } from "@/lib/projects/references";
import { listChats } from "@/lib/chats/store";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store", Vary: "Cookie" };
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const account = await readAccount();
    if (!account) return Response.json({ error: "Sign in to use projects." }, { status: 401, headers });
    const db = await historyDatabase();
    if (!db) throw new Error("Unavailable");
    const { id } = await params;
    const project = await readProject(db, account.ownerId, id);
    if (!project) return Response.json({ error: "Project not found." }, { status: 404, headers });
    const [plans, references, chats] = await Promise.all([listProjectPlans(db, account.ownerId, id), listProjectReferences(db, account.ownerId, id), listChats(db, account.ownerId, id)]);
    return Response.json({ project, plans, references, chats }, { headers });
  } catch { return Response.json({ error: "Context unavailable. Try again." }, { status: 503, headers }); }
}
