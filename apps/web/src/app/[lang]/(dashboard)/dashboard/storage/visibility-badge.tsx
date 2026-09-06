"use client";

import { Globe, Lock, Package } from "lucide-react";
import { Badge } from "@beutl/ui/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@beutl/ui/ui/tooltip";
import { cn } from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";
import type { StorageFile } from "./types";

export function useVisibilitySpec(
  visibility: StorageFile["visibility"],
  lang: string,
) {
  const { t } = useTranslation(lang);
  if (visibility === "PUBLIC") {
    return {
      Icon: Globe,
      label: t("storage:public"),
      hint: t("storage:publicHint"),
      className:
        "border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    };
  }
  if (visibility === "PRIVATE") {
    return {
      Icon: Lock,
      label: t("storage:private"),
      hint: t("storage:privateHint"),
      className: "",
    };
  }
  return {
    Icon: Package,
    label: t("storage:dedicated"),
    hint: t("storage:dedicatedHint"),
    className: "border-dashed text-muted-foreground",
  };
}

export function VisibilityBadge({
  visibility,
  lang,
  className,
}: {
  visibility: StorageFile["visibility"];
  lang: string;
  className?: string;
}) {
  const spec = useVisibilitySpec(visibility, lang);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={cn(
            "gap-1 whitespace-nowrap font-medium",
            spec.className,
            className,
          )}
        >
          <spec.Icon className="h-3 w-3" aria-hidden />
          {spec.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{spec.hint}</TooltipContent>
    </Tooltip>
  );
}
