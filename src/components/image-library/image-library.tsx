import Link from "next/link";
import { ArrowLeft, ArrowRight, Images, LockKeyhole } from "lucide-react";
import type { ImageLibraryPage, ImageLibraryQuery, LibraryImage, LibraryImageDetail } from "@/lib/image-library/types";
import { ImagePreview } from "./image-preview";
import { DownloadImage } from "./download-image";

const FOCUS = "outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70";
const kindLabel = { thumbnail: "Thumbnail", ui: "UI image", other: "Image" };
const stageLabel = { concept: "Concept", final: "Final", asset: "Asset" };
const date = (at: string) => new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" });
const size = (bytes: number) => bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
function url(query: ImageLibraryQuery, cursor?: string) {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.kind !== "all") params.set("kind", query.kind);
  if (query.stage !== "all") params.set("stage", query.stage);
  if (query.projectId) params.set("projectId", query.projectId);
  params.set("limit", String(query.limit));
  if (cursor) params.set("cursor", cursor);
  return `/images?${params}`;
}

export function ImageLibraryHeading() {
  return <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
    <div><h1 className="text-2xl font-semibold tracking-tight">Image library</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-fg-muted">Browse your saved generated images and the details behind each one.</p></div>
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-xs text-fg-muted"><LockKeyhole className="size-3.5" aria-hidden="true" />Private to you</span>
  </header>;
}

function ImageCard({ image }: { image: LibraryImage }) {
  return <article className="overflow-hidden rounded-xl border border-line bg-surface">
    <Link href={`/images/${image.id}`} className={`flex aspect-[3/2] items-center justify-center border-b border-line p-3 ${FOCUS}`} aria-label={`Open ${image.title}`}>
      <ImagePreview id={image.id} title={image.title} />
    </Link>
    <div className="p-4">
      <div className="flex flex-wrap gap-2 text-xs text-fg-muted"><span>{kindLabel[image.generation.kind]}{image.generation.stage ? ` · ${stageLabel[image.generation.stage]}` : ""}</span>
        {image.generation.mode === "test" && <span className="rounded border border-line-strong px-1.5">Test output</span>}</div>
      <h2 className="mt-2 line-clamp-2 break-words text-sm font-semibold"><Link href={`/images/${image.id}`} className={`rounded-sm hover:underline ${FOCUS}`}>{image.title}</Link></h2>
      <p className="mt-1 truncate text-xs text-fg-muted">{image.projectName}</p>
      <p className="mt-2 text-xs text-fg-muted">{image.width} × {image.height} · {image.generation.model ?? "Model not recorded"}</p>
      <time dateTime={image.createdAt} className="mt-1 block text-xs text-fg-subtle">{date(image.createdAt)}</time>
      <div className="mt-4 flex items-center justify-between gap-3 text-xs"><Link href={`/images/${image.id}`} className={`rounded-sm hover:underline ${FOCUS}`}>View details</Link>
        <DownloadImage key={image.id} id={image.id} title={image.title} /></div>
    </div>
  </article>;
}

export function ImageLibraryView({ query, page, state = "ready" }: { query: ImageLibraryQuery; page: ImageLibraryPage; state?: "ready" | "unavailable" | "invalid" }) {
  const filtered = Boolean(query.q || query.kind !== "all" || query.stage !== "all" || query.projectId);
  return <><ImageLibraryHeading />
    <form action="/images" method="get" className="mb-6 flex flex-wrap items-end gap-3">
      <label className="min-w-0 basis-48 flex-1 text-xs text-fg-muted">Search images
        <input name="q" type="search" defaultValue={query.q} maxLength={80} placeholder="Search titles, projects or models" className={`mt-1.5 min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg ${FOCUS}`} /></label>
      <label className="text-xs text-fg-muted">Type<select name="kind" defaultValue={query.kind} className={`mt-1.5 block min-h-11 rounded-lg border border-line bg-surface px-3 text-sm text-fg ${FOCUS}`}>
        <option value="all">All image types</option><option value="thumbnail">Thumbnails</option><option value="ui">UI images</option><option value="other">Other images</option></select></label>
      <label className="text-xs text-fg-muted">Stage<select name="stage" defaultValue={query.stage} className={`mt-1.5 block min-h-11 rounded-lg border border-line bg-surface px-3 text-sm text-fg ${FOCUS}`}>
        <option value="all">All stages</option><option value="concept">Concept</option><option value="final">Final</option><option value="asset">Asset</option></select></label>
      <input type="hidden" name="limit" value={query.limit} />{query.projectId && <input type="hidden" name="projectId" value={query.projectId} />}
      <button className={`min-h-11 rounded-lg bg-fg px-4 text-sm font-medium text-canvas hover:bg-white ${FOCUS}`}>Search</button>
      {filtered && <Link href="/images" className={`flex min-h-11 items-center rounded-md px-2 text-sm text-fg-muted hover:text-fg ${FOCUS}`}>Clear filters</Link>}
    </form>
    {state !== "ready" ? <section role="alert" className="rounded-xl border border-line bg-surface p-8">
      <h2 className="text-sm font-medium">{state === "invalid" ? "Check your filters" : "Image library unavailable"}</h2>
      <p className="mt-2 text-sm text-fg-muted">{state === "invalid" ? "Use a search of up to 80 characters and the available image types and stages." : "Your saved images could not be loaded. Try again later."}</p>
      <Link href={url(query)} className={`mt-4 inline-flex min-h-10 items-center rounded-md border border-line-strong px-3 text-sm hover:bg-surface-hover ${FOCUS}`}>{state === "invalid" ? "Reset filters" : "Try again"}</Link>
    </section> : page.images.length ? <>
      <p className="mb-3 text-xs text-fg-muted">Showing {page.images.length} {page.images.length === 1 ? "image" : "images"}</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">{page.images.map(image => <ImageCard key={image.id} image={image} />)}</div>
      <nav aria-label="Image library pages" className="mt-6 flex items-center justify-between gap-4 text-sm">
        {query.after ? <Link href={url(query)} className={`inline-flex min-h-10 items-center gap-2 rounded-md px-2 hover:bg-surface ${FOCUS}`}><ArrowLeft className="size-4" aria-hidden="true" />First page</Link> : <span />}
        {page.nextCursor && <Link href={url(query, page.nextCursor)} className={`inline-flex min-h-10 items-center gap-2 rounded-md border border-line px-3 hover:bg-surface ${FOCUS}`}>Next page<ArrowRight className="size-4" aria-hidden="true" /></Link>}
      </nav>
    </> : <section className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-line bg-surface p-8 text-center">
      <Images className="mb-4 size-7 text-fg-muted" aria-hidden="true" /><h2 className="text-base font-medium">{filtered ? "No matching images" : query.after ? "No more images" : "No saved generated images"}</h2>
      <p className="mt-2 max-w-md text-sm leading-6 text-fg-muted">{filtered ? "Try another search or clear the filters." : "Images saved by Romanum's creative workflows will appear here. Uploaded reference images stay with their projects."}</p>
      {(filtered || query.after) && <Link href={filtered ? "/images" : url(query)} className={`mt-4 rounded-sm text-sm underline ${FOCUS}`}>{filtered ? "Clear filters" : "Back to first page"}</Link>}
    </section>}
  </>;
}

export function ImageDetailView({ image }: { image: LibraryImageDetail }) {
  return <><Link href="/images" className={`mb-5 inline-flex min-h-10 items-center gap-2 rounded-md text-sm text-fg-muted hover:text-fg ${FOCUS}`}><ArrowLeft className="size-4" aria-hidden="true" />Image library</Link>
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4"><div className="min-w-0 basis-64 flex-1"><h1 className="break-words text-2xl font-semibold tracking-tight">{image.title}</h1><p className="mt-2 break-words text-sm text-fg-muted">{image.projectName} · Private to you</p></div>
      <DownloadImage key={image.id} id={image.id} title={image.title} prominent /></div>
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
      <div className="flex min-h-64 min-w-0 items-center justify-center rounded-xl border border-line bg-surface p-4"><ImagePreview id={image.id} title={image.title} thumbnail={false} /></div>
      <section aria-labelledby="image-details" className="min-w-0 rounded-xl border border-line bg-surface p-5"><h2 id="image-details" className="text-sm font-semibold">Generation details</h2>
        <dl className="mt-4 space-y-3 text-sm">{[
          ["Type", kindLabel[image.generation.kind]], ["Stage", image.generation.stage ? stageLabel[image.generation.stage] : "Not recorded"],
          ["Model", image.generation.model ?? "Not recorded"], ["Provider", image.generation.provider ?? "Not recorded"],
          ["Mode", image.generation.mode === "test" ? "Test output" : image.generation.mode === "paid" ? "Paid generation" : "Not recorded"],
          ["Dimensions", `${image.width} × ${image.height}`], ["File", `PNG · ${size(image.byteLength)}`], ["Saved", date(image.createdAt)],
        ].map(([label, value]) => <div key={label}><dt className="text-xs text-fg-subtle">{label}</dt><dd className="mt-0.5 break-words">{value}</dd></div>)}</dl>
      </section>
    </div>
    <section aria-labelledby="image-prompt" className="mt-6 rounded-xl border border-line bg-surface p-5"><h2 id="image-prompt" className="text-sm font-semibold">Generation prompt</h2>
      <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-fg-muted">{image.prompt ?? "A generation prompt was not recorded for this image."}</p>
      {image.promptTruncated && <p className="mt-3 text-xs text-fg-subtle">Showing the first 8,000 characters of the saved prompt.</p>}
    </section>
  </>;
}
