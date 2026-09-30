import { notFound, redirect } from "next/navigation";
import { readAccount } from "@/lib/accounts/session";
import { historyDatabase } from "@/lib/history/database";
import { readProject } from "@/lib/projects/store";
import { listChats } from "@/lib/chats/store";
import { ProjectSignIn } from "@/components/projects/project-sign-in";
export const dynamic = "force-dynamic";
export default async function ProjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ context?: string }> }) {
  const account = await readAccount();
  if (!account) return <ProjectSignIn />;
  const db = await historyDatabase();
  if (!db) throw new Error("Projects unavailable.");
  const project = await readProject(db, account.ownerId, (await params).id);
  if (!project) notFound();
  const [latest] = await listChats(db, account.ownerId, project.id);
  const context = (await searchParams).context;
  const panel = ["brief", "roadmap", "references", "plans", "ads"].includes(context ?? "") ? context : undefined;
  redirect(latest ? `/chats/${latest.id}${panel ? `?context=${panel}` : ""}` : `/chats?project=${project.id}&context=${panel ?? "brief"}`);
}
