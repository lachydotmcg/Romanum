import { projectResponse } from "@/lib/projects/http";
import { readAccount } from "@/lib/accounts/session";
import { historyDatabase } from "@/lib/history/database";
import { isCrossSite } from "@/lib/guest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const deps = { account: readAccount, database: historyDatabase, isCrossSite };
type Context = { params: Promise<{ id: string }> };
export const GET = async (request: Request, { params }: Context) => projectResponse(request, deps, (await params).id);
export const PUT = async (request: Request, { params }: Context) => projectResponse(request, deps, (await params).id);
