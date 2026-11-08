"use client";

import { Settings } from "lucide-react";
import { useTranslations } from "next-intl";
import { LocaleSubmenu } from "@/components/locale-switcher";
import { ThemeSubmenu } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/** Interface settings in one menu: language and theme. */
export function SettingsMenu() {
  const t = useTranslations("topbar");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label={t("settings")} title={t("settings")}>
          <Settings className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <LocaleSubmenu />
        <ThemeSubmenu />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
