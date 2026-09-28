import type { Metadata } from "next";
import { readAccount } from "@/lib/accounts/session";
import { historyDatabase } from "@/lib/history/database";
import { listProjects } from "@/lib/projects/store";
import { ProjectList } from "@/components/projects/project-list";
import { ProjectSignIn } from "@/components/projects/project-sign-in";

export const metadata: Metadata = { title: "Projects" };
export const dynamic = "force-dynamic";
export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ archived?: string }> }) {
  const account = await readAccount();
  if (!account) return <ProjectSignIn />;
  const db = await historyDatabase();
  if (!db) throw new Error("Projects unavailable.");
  const archived = (await searchParams).archived === "true";
  return <ProjectList projects={await listProjects(db, account.ownerId, { archived })} archived={archived} />;
}
