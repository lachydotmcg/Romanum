import type { Metadata } from "next";
import { connection } from "next/server";
import { ChatView } from "@/components/chats/chat-view";
import { listChats, type ChatSummary } from "@/lib/chats/store";
import { readOwner, readAccount } from "@/lib/accounts/session";
import { readProject, listProjects, type ProjectBrief, type ProjectSummary } from "@/lib/projects/store";
import { notFound } from "next/navigation";
import { ProjectSignIn } from "@/components/projects/project-sign-in";
import { historyDatabase } from "@/lib/history/database";

export const metadata: Metadata = {
  title: "Chats",
};

export default async function ChatsPage({ searchParams }: { searchParams: Promise<{ project?: string; onboarding?: string; archived?: string; context?: string }> }) {
  // Per request: the key check and this browser's chats can't be baked in at build time.
  await connection();
  const owner = await readOwner();
  const { project: projectId, onboarding: onboardingParam, archived: archivedParam, context } = await searchParams;
  const account = await readAccount();
  const onboarding = onboardingParam === "true";
  const archived = archivedParam === "true";
  if (onboarding && !account) return <ProjectSignIn />;
  let project: ProjectBrief | null = null;
  if (projectId !== undefined) {
    if (!account) return <ProjectSignIn />;
    const db = await historyDatabase();
    if (!db) throw new Error("Projects unavailable.");
    project = await readProject(db, account.ownerId, projectId);
    if (!project) notFound();
  }
  let recent: ChatSummary[] = [];
  let projects: ProjectSummary[] = [];
  try {
    const database = await historyDatabase();
    if (owner && database) recent = await listChats(database, owner, project?.id);
    if (account && database && !project) projects = await listProjects(database, account.ownerId, { archived });
  } catch {
    // A new chat still works without the list.
  }
  return <ChatView key={project?.id ?? (onboarding ? "onboarding" : archived ? "archived" : "new")} chatId={null} initialMessages={[]} recent={recent} connected={Boolean(process.env.DEEPSEEK_API_KEY)} project={project} canPlan={!!account} onboarding={onboarding} projects={projects} archived={archived} contextTab={context} />;
}
