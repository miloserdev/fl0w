"use client";

import { Settings } from "lucide-react";
import { useTranslations } from "next-intl";
import { LocaleSubmenu } from "@/components/locale-switcher";
import { ThemeSubmenu } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/** Настройки интерфейса одним меню: язык и тема. */
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
