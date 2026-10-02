import { useState } from "react";
import { cn, hueOf } from "@/lib/utils";

/**
 * Logos are served from our own origin through the server's logo proxy, so visitors' IPs and user agents never
 * reach the projects being scored (and the CSP allows images from 'self' only). Relative and data: URLs pass through.
 */
export function logoSrc(logoUrl: string | null | undefined): string | null {
  if (!logoUrl) return null;
  if (logoUrl.startsWith("/") || logoUrl.startsWith("data:image/")) return logoUrl;
  if (/^https?:\/\//i.test(logoUrl)) return `/api/public/logo?u=${encodeURIComponent(logoUrl)}`;
  return null;
}

export function ProjectMark({ name, logoUrl, size = 20, className }: { name: string; logoUrl?: string | null; size?: number; className?: string }) {
  const src = logoSrc(logoUrl);
  const [failed, setFailed] = useState<string | null>(null);
  const h = hueOf(name);
  const style = { width: size, height: size, borderRadius: size * 0.3 };
  if (src && failed !== src) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        onError={() => setFailed(src)}
        style={style}
        className={cn("shrink-0 border border-black/5 bg-white object-contain dark:border-white/10", className)}
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{ ...style, background: `oklch(0.93 0.05 ${h})`, color: `oklch(0.42 0.12 ${h})`, fontSize: size * 0.48 }}
      className={cn("inline-flex shrink-0 items-center justify-center border border-black/5 font-semibold dark:border-white/10", className)}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
