import { notFound } from "next/navigation";
import Link from "next/link";
import { readAccount } from "@/lib/accounts/session";
import { historyDatabase } from "@/lib/history/database";
import { studioPageContext, STUDIO_WORKFLOW_ENABLED } from "@/lib/agent-api-studio-workflow/private-route";
import { StudioWorkspace } from "@/components/agent-studio/workspace";

export const dynamic = "force-dynamic";
export const metadata = { title: "Studio review" };
export default async function StudioReviewPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const context = await studioPageContext({ account: readAccount, database: historyDatabase, enabled: STUDIO_WORKFLOW_ENABLED }, projectId);
  if (context.state === "not_found") notFound();
  if (context.state === "sign_in") return <main className="studio-disabled" id="main-content"><h1>Sign in to review Studio changes</h1><p>This workspace belongs to a signed-in project owner.</p><Link href="/profile">Open your profile</Link></main>;
  if (context.state === "unavailable") return <main className="studio-disabled" id="main-content"><h1>Studio review unavailable</h1><p>Try again when the project service is available.</p></main>;
  if (context.state === "disabled") return <main className="studio-disabled" id="main-content"><p>{context.project.name}</p><h1>Studio review is not enabled</h1><p>The authored offline preview demonstrates selection, inspection, exact review, cancellation and recovery. Live Studio access has not been activated.</p><p>Private route integration is disabled until its schema, data export and owner-established connection are reviewed.</p><Link href="/chats">Return to your workspace</Link></main>;
  return <StudioWorkspace projectId={projectId} projectName={context.project.name} archived={context.project.archived}/>;
}
