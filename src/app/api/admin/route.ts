import { ownerAdminReport } from "@/lib/admin/server";
import { adminResponse } from "@/lib/admin/http";
import { adminPage } from "@/lib/admin/query";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(request: Request) {
  return adminResponse(await ownerAdminReport(adminPage(new URL(request.url).searchParams.get("page"))));
}
