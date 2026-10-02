import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ImageDetailView } from "@/components/image-library/image-library";
import { imageLibraryDependencies } from "@/lib/image-library/server";
import { idSchema } from "@/lib/creative/schema";

export const metadata: Metadata = { title: "Saved image", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";
export default async function ImagePage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const account = await imageLibraryDependencies.account();
  const { id } = await params;
  if (!account || !idSchema.safeParse(id).success) notFound();
  let storage;
  try { storage = await imageLibraryDependencies.storage(); } catch { /* Show a private unavailable state. */ }
  if (!storage) return <section role="alert"><h1 className="text-xl font-semibold">Image unavailable</h1><p className="mt-2 text-sm text-fg-muted">Your saved image could not be loaded. Try again later.</p><Link href="/images" className="mt-4 inline-block text-sm underline">Back to image library</Link></section>;
  let image;
  try { image = await storage.detail(account.ownerId, id); }
  catch { return <section role="alert"><h1 className="text-xl font-semibold">Image unavailable</h1><p className="mt-2 text-sm text-fg-muted">Your saved image could not be loaded. Try again later.</p><Link href="/images" className="mt-4 inline-block text-sm underline">Back to image library</Link></section>; }
  if (!image) notFound();
  return <ImageDetailView image={image} />;
}
