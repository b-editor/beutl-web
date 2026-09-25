"use client";

import { useTranslation } from "@beutl/ui/i18n-client";
import { Button } from "@beutl/ui/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@beutl/ui/ui/popover";
import { CircleHelp } from "lucide-react";
import type { ReactNode } from "react";

export function HelpPopover({
  lang,
  title,
  children,
}: {
  lang: string;
  title: string;
  children: ReactNode;
}) {
  const { t } = useTranslation(lang);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground"
          aria-label={t("admin:common.helpFor", { name: title })}
        >
          <CircleHelp className="size-4" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-[70vh] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto text-sm">
        <p className="mb-2 font-medium">{title}</p>
        <div className="space-y-2 text-muted-foreground">{children}</div>
      </PopoverContent>
    </Popover>
  );
}
