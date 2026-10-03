import type { Metadata } from "next";
import { connection } from "next/server";
import { SignInButton } from "@/components/account/sign-in";
import { ImageLibraryHeading, ImageLibraryView } from "@/components/image-library/image-library";
import { oauthClient } from "@/lib/accounts/roblox-oauth";
import { imageLibraryDependencies } from "@/lib/image-library/server";
import { IMAGE_LIBRARY_PAGE_SIZE, imageLibrarySearchParams, parseImageLibraryQuery } from "@/lib/image-library/query";
import type { ImageLibraryPage, ImageLibraryQuery } from "@/lib/image-library/types";

export const metadata: Metadata = { title: "Image library", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";
export default async function ImagesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  let account;
  try { account = await imageLibraryDependencies.account(); }
  catch { return <ImageLibraryView query={{ q: "", kind: "all", stage: "all", projectId: null, limit: IMAGE_LIBRARY_PAGE_SIZE, after: null }} page={{ images: [], nextCursor: null }} state="unavailable" />; }
  if (!account) return <><ImageLibraryHeading /><section className="rounded-xl border border-line bg-surface p-8"><h2 className="text-base font-medium">Sign in to view your images</h2><p className="my-3 text-sm text-fg-muted">Your saved images are private to your account.</p>{oauthClient() ? <SignInButton /> : <p className="text-sm text-fg-muted">Sign-in unavailable.</p>}</section></>;
  let query: ImageLibraryQuery;
  try { query = parseImageLibraryQuery(imageLibrarySearchParams(await searchParams), account.ownerId); }
  catch { return <ImageLibraryView query={parseImageLibraryQuery(new URLSearchParams(), account.ownerId)} page={{ images: [], nextCursor: null }} state="invalid" />; }
  let page: ImageLibraryPage | null = null;
  try {
    const storage = await imageLibraryDependencies.storage();
    if (storage) page = await storage.list(account.ownerId, query);
  } catch { /* Unavailable is distinct from an empty library. */ }
  return <ImageLibraryView query={query} page={page ?? { images: [], nextCursor: null }} state={page ? "ready" : "unavailable"} />;
}
