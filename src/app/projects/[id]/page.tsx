import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { readAccount } from "@/lib/accounts/session";
import { historyDatabase } from "@/lib/history/database";
import { readProject } from "@/lib/projects/store";
import { listChats } from "@/lib/chats/store";
import { ProjectEditor } from "@/components/projects/project-editor";
import { ProjectSignIn } from "@/components/projects/project-sign-in";

export const metadata: Metadata = { title: "Project brief" };
export const dynamic = "force-dynamic";
export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const account = await readAccount();
  if (!account) return <ProjectSignIn />;
  const db = await historyDatabase();
  if (!db) throw new Error("Projects unavailable.");
  const project = await readProject(db, account.ownerId, (await params).id);
  if (!project) notFound();
  const chats = await listChats(db, account.ownerId, project.id);
  return <><ProjectEditor key={project.id} initial={project} />{chats.length > 0 && <section className="mx-auto mt-12 max-w-3xl border-t border-line pt-6" aria-labelledby="project-chats">
    <h2 id="project-chats" className="mb-3 text-base font-medium">Chats</h2><ul>{chats.map((chat) => <li key={chat.id}><Link href={`/chats/${chat.id}`} className="block truncate rounded-lg px-3 py-3 text-sm text-fg-muted outline-offset-2 hover:bg-surface hover:text-fg focus-visible:outline-2 focus-visible:outline-fg/70">{chat.title}</Link></li>)}</ul>
  </section>}</>;
}
