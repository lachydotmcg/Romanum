import { imageLibraryResponse } from "@/lib/image-library/http";
import { imageLibraryDependencies } from "@/lib/image-library/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return imageLibraryResponse(request, imageLibraryDependencies, (await params).id);
}
