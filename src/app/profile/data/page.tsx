import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { readAccount } from "@/lib/accounts/session";
import { oauthClient } from "@/lib/accounts/roblox-oauth";
import { SignInButton } from "@/components/account/sign-in";
import { DataDownload } from "@/components/account/data-download";
import { DeleteAccount } from "@/components/account/delete-account";

export const metadata: Metadata = { title: "Your data" };
export const dynamic = "force-dynamic";

export default async function AccountDataPage() {
  const account = await readAccount();
  return (
    <div className="mx-auto w-full max-w-2xl">
      <Link href="/profile" className="text-sm text-fg-muted hover:text-fg">Profile</Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">Your data</h1>
      {account ? (
        <div className="mt-7 space-y-4">
          <DataDownload />
          <Link href="/profile#games" className="flex min-h-20 items-center justify-between gap-4 rounded-xl border border-line p-5 hover:bg-surface-hover sm:p-6">
            <div><h2 className="font-medium">Game data & sharing</h2><p className="mt-1 text-sm text-fg-muted">Manage collection, sharing and saved metrics.</p></div>
            <ChevronRight className="size-4 shrink-0 text-fg-muted" aria-hidden="true" />
          </Link>
          <div className="pt-3"><DeleteAccount accountId={account.id} username={account.username} /></div>
        </div>
      ) : (
        <div className="mt-7 space-y-4"><p className="text-sm text-fg-muted">Sign in to manage your data.</p>{oauthClient() && <SignInButton />}</div>
      )}
    </div>
  );
}
