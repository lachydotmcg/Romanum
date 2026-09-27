"use client";

import Image from "next/image";
import { useState } from "react";
import { User } from "lucide-react";
import { isRobloxImageUrl } from "@/lib/roblox-icons";

/** The Roblox headshot of whoever's signed in, or the guest icon. */
export function Avatar({ url, className = "size-7", iconClassName = "size-4" }: { url?: string | null; className?: string; iconClassName?: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const usable = url && url !== failedUrl && isRobloxImageUrl(url);
  return (
    <span className={`relative grid shrink-0 place-items-center overflow-hidden rounded-full bg-surface text-white ${className}`}>
      {usable ? (
        <Image src={url} alt="" fill sizes="48px" unoptimized className="object-cover" onError={() => setFailedUrl(url)} />
      ) : (
        <User className={iconClassName} strokeWidth={1.75} aria-hidden="true" />
      )}
    </span>
  );
}
