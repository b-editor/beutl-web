"use client";

import { useState } from "react";
import { useTranslation } from "@beutl/ui/i18n-client";
import { Button } from "@beutl/ui/ui/button";
import { Input } from "@beutl/ui/ui/input";
import { Check, Copy } from "lucide-react";

export function CloneUrl({ lang, url }: { lang: string; url: string }) {
  const { t } = useTranslation(lang);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex max-w-xl items-center gap-2">
      <Input value={url} readOnly aria-label={t("repositories:cloneUrl")} />
      <Button
        variant="outline"
        size="icon"
        onClick={copy}
        aria-label={copied ? t("repositories:copied") : t("repositories:copy")}
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </Button>
    </div>
  );
}
