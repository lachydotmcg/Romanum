import type { AdminResult } from "./service.ts";

export const ADMIN_HEADERS = { "Cache-Control":"private, no-store, max-age=0", "Vary":"Cookie", "X-Robots-Tag":"noindex, nofollow" };
export function adminResponse(result: AdminResult) {
  if (result.status === "denied") return Response.json({error:"Not found."},{status:404,headers:ADMIN_HEADERS});
  if (result.status === "unavailable") return Response.json({error:"Reporting unavailable."},{status:503,headers:ADMIN_HEADERS});
  return Response.json({mode:"live",report:result.report},{headers:ADMIN_HEADERS});
}
