"use client";

import type { ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Подсказка в стиле приложения вместо нативного `title` (жёлтая «хромовая» плашка). Для отключённой кнопки нужна обёртка —
 * у неё нет событий мыши: передайте `wrap`.
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
