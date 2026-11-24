"use client";

import { useState, type ComponentProps } from "react";
import { AppWindow } from "lucide-react";
import { cn } from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";
import { Button } from "@beutl/ui/ui/button";
import { desktopOpenRepositoryUrl } from "@/lib/desktop-install";

type OpenInBeutlButtonProps = Pick<ComponentProps<typeof Button>, "variant" | "size" | "className"> & {
  repositoryId: string;
  refName?: string | null;
  lang: string;
  showLaunchNotice?: boolean;
  containerClassName?: string;
};

export function OpenInBeutlButton({
  repositoryId,
  refName,
  lang,
  showLaunchNotice = true,
  variant,
  size,
  className,
  containerClassName,
}: OpenInBeutlButtonProps) {
  const { t } = useTranslation(lang);
  const [launchRequested, setLaunchRequested] = useState(false);

  return (
    <div className={cn("flex min-w-0 flex-col items-start", containerClassName)}>
      <Button asChild variant={variant} size={size} className={className}>
        <a
          href={desktopOpenRepositoryUrl(repositoryId, refName)}
          onClick={showLaunchNotice ? () => setLaunchRequested(true) : undefined}
        >
          <AppWindow aria-hidden />
          {t("dashboard:repositories.openInBeutl")}
        </a>
      </Button>
      {showLaunchNotice && (
        <div role="status">
          {launchRequested && (
            <p className="mt-1.5 flex flex-wrap items-baseline gap-x-1.5 text-xs leading-relaxed text-muted-foreground">
              {t("dashboard:repositories.desktopAppDidNotOpen")}{" "}
              <a
                href="https://github.com/b-editor/beutl/releases/latest"
                className="whitespace-nowrap font-medium text-foreground underline underline-offset-4 hover:text-primary"
              >
                {t("dashboard:repositories.downloadBeutl")}
              </a>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
