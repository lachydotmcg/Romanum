import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { readAccount } from "@/lib/accounts/session";
import { historyDatabase } from "@/lib/history/database";
import { readProject } from "@/lib/projects/store";
import { readProjectPlan } from "@/lib/projects/plans";
import { ProjectSignIn } from "@/components/projects/project-sign-in";
import { PlanView } from "@/components/projects/plan-view";

export const metadata: Metadata = { title: "Asset plan" };
export const dynamic = "force-dynamic";
export default async function AssetPlanPage({ params }: { params: Promise<{ id: string; planId: string }> }) {
  const account = await readAccount();
  if (!account) return <ProjectSignIn />;
  const db = await historyDatabase();
  if (!db) throw new Error("Projects unavailable.");
  const { id, planId } = await params;
  const [project, plan] = await Promise.all([readProject(db, account.ownerId, id), readProjectPlan(db, account.ownerId, id, planId)]);
  if (!project || !plan) notFound();
  return <PlanView plan={plan} projectName={project.name} />;
}
