import { type ErrorComponentProps, Link } from "@tanstack/react-router";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isChunkError } from "@/lib/recovery";

/**
 * Every route's error boundary (R3-REL-14): a styled page with a way out, instead of TanStack's unstyled default.
 * A page whose code is gone after a deploy asks for a reload; anything else says reloading usually fixes it.
 */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const updated = isChunkError(error);
  return (
    <div role="alert" className="mx-auto flex max-w-lg flex-col items-center px-6 py-32 text-center">
      <div className="eyebrow">{updated ? "New version" : "Error"}</div>
      <h1 className="mt-3 text-3xl font-medium tracking-[-0.01em] text-balance">
        {updated ? "This site was just updated." : "This page couldn't be shown."}{" "}
        <span className="text-muted">{updated ? "Reload to get the new version." : "Reloading usually fixes it."}</span>
      </h1>
      <Button variant="primary" className="mt-8" icon={<RotateCw className="size-4" />} onClick={() => location.reload()}>
        Reload
      </Button>
      <Link to="/" className="mt-3 text-sm text-muted hover:text-fg" onClick={() => reset()}>
        Or go back home
      </Link>
    </div>
  );
}
