import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { ChatView } from "@/components/chats/chat-view";
import { readChat } from "@/lib/chats/store";
import { readOwner, readAccount } from "@/lib/accounts/session";
import { historyDatabase } from "@/lib/history/database";
import { readProject } from "@/lib/projects/store";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ context?: string }> };

// Request memoisation shares one read between the title and the page. A database failure reaches the error page.
const getChat = cache(async (id: string) => {
  const owner = await readOwner();
  const database = await historyDatabase();
  if (!database) throw new Error("Chats unavailable.");
  return owner ? readChat(database, owner, id) : null;
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  await connection();
  const chat = await getChat((await params).id);
  return { title: chat?.title ?? "Chat not found" };
}

export default async function ChatPage({ params, searchParams }: Props) {
  await connection();
  const chat = await getChat((await params).id);
  if (!chat) notFound();
  const owner = await readOwner();
  const db = await historyDatabase();
  const project = chat.projectId && owner && db ? await readProject(db, owner, chat.projectId) : null;
  return <ChatView key={chat.id} chatId={chat.id} initialMessages={chat.messages} recent={null} connected={Boolean(process.env.DEEPSEEK_API_KEY)} project={project} canPlan={!!await readAccount()} contextTab={(await searchParams).context} />;
}
