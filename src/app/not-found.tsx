import Link from "next/link";

export default function NotFound() {
  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight">Page not found.</h1>
      <Link href="/analytics" className="mt-5 inline-flex min-h-11 items-center rounded-lg border border-line px-4 text-sm hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-fg-muted">Back to Analytics</Link>
    </section>
  );
}
