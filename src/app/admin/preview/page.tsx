import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AdminDashboard } from "@/components/admin/dashboard";
import { adminPreviewAllowed } from "@/lib/admin/access";
import { adminFixtureReport, adminPreviewState } from "@/lib/admin/fixtures";

export const metadata: Metadata = { title: "Local admin fixture preview", robots: { index: false, follow: false } };
export default async function AdminPreviewPage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  if (process.env.NODE_ENV !== "development") notFound();
  const requestHeaders = await headers();
  if (!adminPreviewAllowed(process.env.NODE_ENV, requestHeaders.get("host") ?? "", requestHeaders.get("origin"))) notFound();
  const state = adminPreviewState((await searchParams).state);
  return <AdminDashboard report={adminFixtureReport(state)} state={state} />;
}
