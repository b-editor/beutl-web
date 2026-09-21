"use client";

import { useState } from "react";
import { Button } from "@beutl/ui/ui/button";
import { useTranslation } from "@beutl/ui/i18n-client";
import { desktopInstallUrl } from "@/lib/desktop-install";

export function DesktopInstallButton({
  packageName,
  version,
  lang,
}: {
  packageName: string;
  version?: string;
  lang: string;
}) {
  const { t } = useTranslation(lang);
  const [launchRequested, setLaunchRequested] = useState(false);

  return (
    <>
      {version ? (
        <Button asChild>
          <a
            href={desktopInstallUrl(packageName, version)}
            onClick={() => setLaunchRequested(true)}
          >
            {t("store:installInBeutl")}
          </a>
        </Button>
      ) : (
        <Button disabled>{t("store:installInBeutl")}</Button>
      )}
      {launchRequested && (
        <p className="max-w-xs text-sm text-muted-foreground" role="status">
          {t("store:desktopAppDidNotOpen")}{" "}
          <a
            href="https://github.com/b-editor/beutl/releases/latest"
            className="underline underline-offset-4"
          >
            {t("store:downloadBeutl")}
          </a>
        </p>
      )}
    </>
  );
}
