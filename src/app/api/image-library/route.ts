import { imageLibraryResponse } from "@/lib/image-library/http";
import { imageLibraryDependencies } from "@/lib/image-library/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => imageLibraryResponse(request, imageLibraryDependencies);
