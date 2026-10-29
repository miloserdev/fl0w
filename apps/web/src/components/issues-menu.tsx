"use client";

import { TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type IssueEntry = { key: string; text: string; nodeId?: string };

/** Список проблем флоу; клик по пункту выделяет ноду на холсте. */
export function IssuesMenu({
  issues,
  onSelectNode,
}: {
  issues: IssueEntry[];
  onSelectNode: (nodeId: string) => void;
}) {
  const t = useTranslations("topbar");
  if (issues.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="text-destructive">
          <TriangleAlert className="size-4" />
          {t("problems", { count: issues.length })}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-md">
        <DropdownMenuLabel>{t("problemsTitle")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {issues.map((i) => (
          <DropdownMenuItem
            key={i.key}
            disabled={!i.nodeId}
            className="whitespace-normal"
            onClick={() => i.nodeId && onSelectNode(i.nodeId)}
          >
            {i.text}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
