import type { Metadata } from "next";
import { after } from "next/server";
import { Avatar } from "@/components/account/avatar";
import { SignInButton } from "@/components/account/sign-in";
import { LinkedGames } from "@/components/account/linked-games";
import { oauthClient } from "@/lib/accounts/roblox-oauth";
import { readAccount } from "@/lib/accounts/session";
import { historyDatabase } from "@/lib/history/database";
import { syncDueGames } from "@/lib/linked-games/sync";
import { linkedGameViews, type LinkedGameView } from "@/lib/linked-games/view";

export const metadata: Metadata = {
  title: "Profile",
};
export const dynamic = "force-dynamic";

const FOCUS = "outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70";

/** What happened to a sign-in, from the ?signin= Roblox's redirect back leaves. */
const NOTICES: Record<string, string> = {
  unavailable: "Sign in with Roblox isn't set up.",
  failed: "Couldn't sign in with Roblox. Try again.",
  cancelled: "Sign-in cancelled.",
  expired: "Sign-in timed out. Try again.",
};

export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ signin?: string }> }) {
  const { signin } = await searchParams;
  const notice = signin ? NOTICES[signin] : undefined;
  const account = await readAccount();
  const signInAvailable = oauthClient() !== null;

  let games: LinkedGameView[] | null = null;
  if (account) {
    const database = await historyDatabase().catch(() => null);
    if (database) {
      games = await linkedGameViews(database, account.id);
      // Games due a sync start one once the page is sent.
      after(() => syncDueGames(database, { accountId: account.id }).catch(() => {}));
    }
  }

  return (
    <>
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar url={account?.pictureUrl} className="size-12" iconClassName="size-6" />
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{account?.displayName ?? "Guest"}</h1>
            {account && <p className="truncate text-sm text-fg-muted">@{account.username}</p>}
          </div>
        </div>
        {account ? (
          <form action="/auth/sign-out" method="post">
            <button type="submit" className={`min-h-11 rounded-lg border border-line px-4 text-sm text-fg hover:bg-surface-hover ${FOCUS}`}>
              Sign out
            </button>
          </form>
        ) : (
          signInAvailable && <SignInButton />
        )}
      </header>
      {notice && (
        <p role="status" className="mt-4 text-sm text-fg-muted">
          {notice}
        </p>
      )}

      <section id="games" aria-labelledby="games-heading" className="mt-9 scroll-mt-8">
        <h2 id="games-heading" className="text-base font-semibold tracking-tight">
          Your games
        </h2>
        {games ? (
          <LinkedGames initial={games} />
        ) : (
          <div className="mt-4 grid min-h-32 place-items-center rounded-xl border border-line px-6 py-8 text-center">
            <p className="text-sm text-fg-muted">
              {account ? "Your games are unavailable." : signInAvailable ? "Sign in with Roblox to link your games." : "No games connected"}
            </p>
          </div>
        )}
      </section>
    </>
  );
}
