import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { ChatView } from "@/components/chats/chat-view";
import { readChat } from "@/lib/chats/store";
import { readGuest } from "@/lib/guest";
import { historyDatabase } from "@/lib/history/database";

type Props = { params: Promise<{ id: string }> };

// Request memoisation shares one read between the title and the page. A database failure reaches the error page.
const getChat = cache(async (id: string) => {
  const owner = await readGuest();
  const database = await historyDatabase();
  if (!database) throw new Error("Chats unavailable.");
  return owner ? readChat(database, owner, id) : null;
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  await connection();
  const chat = await getChat((await params).id);
  return { title: chat?.title ?? "Chat not found" };
}

export default async function ChatPage({ params }: Props) {
  await connection();
  const chat = await getChat((await params).id);
  if (!chat) notFound();
  return <ChatView key={chat.id} chatId={chat.id} initialMessages={chat.messages} recent={null} connected={Boolean(process.env.DEEPSEEK_API_KEY)} />;
}
