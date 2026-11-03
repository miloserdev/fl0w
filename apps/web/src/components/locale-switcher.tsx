"use client";

import { Languages } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { setLocale } from "@/i18n/actions";
import { locales } from "@/i18n/config";

/** Подменю «Язык» для меню настроек. */
export function LocaleSubmenu() {
  const t = useTranslations("language");
  const locale = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={pending}>
        <Languages className="size-4" />
        {t("label")}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup
          value={locale}
          onValueChange={(next) =>
            startTransition(async () => {
              await setLocale(next);
              router.refresh();
            })
          }
        >
          {locales.map((l) => (
            <DropdownMenuRadioItem key={l} value={l}>
              {t(l)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
