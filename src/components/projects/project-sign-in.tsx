import { SignInButton } from "../account/sign-in";
import { oauthClient } from "@/lib/accounts/roblox-oauth";

export function ProjectSignIn() {
  return <section className="mx-auto flex min-h-[60dvh] max-w-xl flex-col items-center justify-center gap-5 text-center">
    <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
    <p className="text-sm text-fg-muted">Keep your game’s brief and chats together.</p>
    {oauthClient() ? <SignInButton /> : <p className="text-sm text-fg-muted">Sign-in unavailable.</p>}
  </section>;
}
