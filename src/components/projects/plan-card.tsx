import Link from "next/link";
import { ArrowUpRight, LayoutPanelTop, ImageIcon } from "lucide-react";
import type { SavedPlanCard } from "@/lib/assistant/types";

export function PlanCard({ plan }: { plan: SavedPlanCard }) {
  const Icon = plan.kind === "ui" ? LayoutPanelTop : ImageIcon;
  return <Link href={`/projects/${plan.projectId}/plans/${plan.id}`} className="flex items-center gap-4 rounded-xl border border-line px-4 py-4 outline-offset-2 hover:bg-surface focus-visible:outline-2 focus-visible:outline-fg/70">
    <Icon className="size-5 shrink-0 text-white" aria-hidden="true" />
    <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{plan.title}</p><p className="mt-1 text-xs text-fg-muted">{plan.kind === "ui" ? "UI" : "Thumbnail"} plan · {plan.conceptCount} {plan.conceptCount === 1 ? "concept" : "concepts"}</p></div>
    <ArrowUpRight className="size-4 shrink-0 text-white" aria-hidden="true" />
  </Link>;
}
