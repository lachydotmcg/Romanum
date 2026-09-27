import type { ReactNode } from "react";
import { RevenueProvider } from "@/components/analytics/revenue";

export default function AnalyticsLayout({ children }: {children: ReactNode}) {
  return <RevenueProvider>{children}</RevenueProvider>;
}
