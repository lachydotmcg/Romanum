import type { Metadata } from "next";
import { User } from "lucide-react";

export const metadata: Metadata = {
  title: "Profile",
};

// Accounts and game connections don't exist yet, so the profile is the guest with no games.
export default function ProfilePage() {
  return (
    <>
      <header className="flex items-center gap-3">
        <span className="grid size-12 shrink-0 place-items-center rounded-full bg-surface-hover text-fg-muted">
          <User className="size-6" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <h1 className="text-2xl font-semibold tracking-tight">Guest</h1>
      </header>

      <section id="games" aria-labelledby="games-heading" className="mt-9 scroll-mt-8">
        <h2 id="games-heading" className="text-base font-semibold tracking-tight">
          Your games
        </h2>
        <div className="mt-4 grid min-h-32 place-items-center rounded-xl border border-line px-6 py-8 text-center">
          <p className="text-sm text-fg-muted">No games connected</p>
        </div>
      </section>
    </>
  );
}
