import * as T from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <T.Provider delayDuration={250} skipDelayDuration={150}>
      {children}
    </T.Provider>
  );
}

export function Tip({ content, children, side = "top" }: { content: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  if (!content) return <>{children}</>;
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          collisionPadding={12}
          className="z-50 max-w-[300px] rounded-lg border border-line bg-bg px-2.5 py-1.5 text-xs leading-[1.45] text-fg-2 shadow-3 data-[state=delayed-open]:animate-in"
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
