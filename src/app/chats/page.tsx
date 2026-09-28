import type { Metadata } from "next";
import { connection } from "next/server";
import { ChatView } from "@/components/chats/chat-view";
import { listChats, type ChatSummary } from "@/lib/chats/store";
import { readOwner, readAccount } from "@/lib/accounts/session";
import { readProject, type ProjectBrief } from "@/lib/projects/store";
import { notFound } from "next/navigation";
import { ProjectSignIn } from "@/components/projects/project-sign-in";
import { historyDatabase } from "@/lib/history/database";

export const metadata: Metadata = {
  title: "Chats",
};

export default async function ChatsPage({ searchParams }: { searchParams: Promise<{ project?: string }> }) {
  // Per request: the key check and this browser's chats can't be baked in at build time.
  await connection();
  const owner = await readOwner();
  const projectId = (await searchParams).project;
  let project: ProjectBrief | null = null;
  if (projectId !== undefined) {
    const account = await readAccount();
    if (!account) return <ProjectSignIn />;
    const db = await historyDatabase();
    if (!db) throw new Error("Projects unavailable.");
    project = await readProject(db, account.ownerId, projectId);
    if (!project || project.archived) notFound();
  }
  let recent: ChatSummary[] = [];
  try {
    const database = await historyDatabase();
    if (owner && database) recent = await listChats(database, owner, project?.id);
  } catch {
    // A new chat still works without the list.
  }
  return <ChatView key={project?.id ?? "new"} chatId={null} initialMessages={[]} recent={recent} connected={Boolean(process.env.DEEPSEEK_API_KEY)} project={project ? { id: project.id, name: project.name, archived: project.archived } : null} />;
}
