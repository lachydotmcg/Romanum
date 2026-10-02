import { notFound } from "next/navigation";
import { AdminDashboard } from "@/components/admin/dashboard";
import { ownerAdminReport } from "@/lib/admin/server";
import { adminPage } from "@/lib/admin/query";

export const dynamic="force-dynamic";
export const metadata={title:"Owner admin",robots:{index:false,follow:false}};
export default async function AdminPage({searchParams}:{searchParams:Promise<{page?:string}>}) {
  const result=await ownerAdminReport(adminPage((await searchParams).page));
  if (result.status === "denied") notFound();
  return <AdminDashboard mode="live" report={result.status === "ok" ? result.report : null} state={result.status === "ok" ? "overview" : "unavailable"} />;
}
