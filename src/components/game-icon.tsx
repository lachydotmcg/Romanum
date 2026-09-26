"use client";

import Image from "next/image";
import { Gamepad2 } from "lucide-react";
import { useState } from "react";
import { isRobloxImageUrl } from "@/lib/roblox-icons";

/** Roblox already serves these at thumbnail size. A failed image never hides the game. */
export function GameIcon({ url, name, className = "size-10" }: { url?: string | null; name: string; className?: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const usable = url && url !== failedUrl && isRobloxImageUrl(url);
  return (
    <span className={`relative grid shrink-0 place-items-center overflow-hidden rounded-lg border border-white/5 bg-surface-hover ${className}`}>
      {usable ? (
        <Image src={url} alt={`${name} icon`} fill sizes="64px" unoptimized className="object-cover" onError={() => setFailedUrl(url)} />
      ) : (
        <Gamepad2 className="size-5 text-white" aria-label={`${name} icon unavailable`} />
      )}
    </span>
  );
}
