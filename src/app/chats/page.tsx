import type { Metadata } from "next";
import { connection } from "next/server";
import { ChatView } from "@/components/chats/chat-view";
import { listChats, type ChatSummary } from "@/lib/chats/store";
import { readGuest } from "@/lib/guest";
import { historyDatabase } from "@/lib/history/database";

export const metadata: Metadata = {
  title: "Chats",
};

export default async function ChatsPage() {
  // Per request: the key check and the guest's chats can't be baked in at build time.
  await connection();
  const owner = await readGuest();
  let recent: ChatSummary[] = [];
  try {
    const database = await historyDatabase();
    if (owner && database) recent = await listChats(database, owner);
  } catch {
    // A new chat still works without the list.
  }
  return <ChatView key="new" chatId={null} initialMessages={[]} recent={recent} connected={Boolean(process.env.DEEPSEEK_API_KEY)} />;
}
