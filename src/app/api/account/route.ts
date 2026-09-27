import { oauthClient } from "@/lib/accounts/roblox-oauth";
import { readAccount } from "@/lib/accounts/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who's signed in, for the sidebar. Only what the page shows: never the account's IDs. */
export async function GET() {
  const account = await readAccount();
  return Response.json(
    {
      account: account && { displayName: account.displayName, username: account.username, pictureUrl: account.pictureUrl },
      signInAvailable: oauthClient() !== null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
