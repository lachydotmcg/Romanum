import { createPublicHttpHandler } from "@/lib/public-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = createPublicHttpHandler("market");
