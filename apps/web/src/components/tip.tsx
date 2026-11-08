"use client";

import type { ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * App-styled tooltip instead of the native `title` (the yellow Chrome box). A disabled button needs a wrapper —
 * it has no mouse events: pass `wrap`.
 */
export function Tip({ label, children, wrap }: { label: string | undefined; children: ReactElement; wrap?: boolean }) {
  if (!label) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{wrap ? <span className="inline-flex">{children}</span> : children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
