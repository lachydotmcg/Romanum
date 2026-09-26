import type { Metadata } from "next";
import { connection } from "next/server";
import { Assistant } from "@/components/assistant/assistant";

export const metadata: Metadata = {
  title: "Analytics",
};

export default async function AnalyticsPage() {
  // Check for the key per request rather than baking the answer in at build time.
  await connection();
  const connected = Boolean(process.env.DEEPSEEK_API_KEY);

  return (
    <>
      <Assistant connected={connected} />

      <section aria-labelledby="analytics-heading" className="mt-10">
        <h1 id="analytics-heading" className="text-xl font-semibold tracking-tight text-fg">
          Analytics
        </h1>
        <div className="mt-4 grid min-h-88 place-items-center rounded-xl border border-line px-6 py-12 text-center">
          <div>
            <p className="text-sm font-medium text-fg">No data connected</p>
            <p className="mt-1 text-sm text-fg-muted">
              Analytics will appear here once a game&apos;s data is connected.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
