import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import { Sidebar } from "@/components/sidebar";
import "./globals.css";

const geist = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "Romanum", template: "%s · Romanum" },
  description: "Create without limits.",
};

export const viewport: Viewport = {
  themeColor: "#050505",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geist.variable} h-full antialiased`}>
      <body className="min-h-full">
        <a href="#main-content" className="sr-only z-50 rounded-lg bg-fg px-4 py-3 text-sm text-canvas focus:not-sr-only focus:fixed focus:top-3 focus:left-20">Skip to content</a>
        <Sidebar />
        <main id="main-content" tabIndex={-1} className="pl-16 outline-none">
          <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8 sm:py-8">{children}</div>
        </main>
      </body>
    </html>
  );
}
