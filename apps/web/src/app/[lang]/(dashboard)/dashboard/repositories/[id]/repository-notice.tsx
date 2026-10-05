import Link from "next/link";
import { FolderSearch, GitBranch, ServerOff } from "lucide-react";
import { getTranslation } from "@beutl/i18n";

/** A full-width message in place of the file list or history. */
export async function RepositoryNotice({
  lang,
  kind,
  cloneUrl,
  rootHref,
}: {
  lang: string;
  kind: "empty" | "notFound" | "unavailable";
  cloneUrl?: string;
  rootHref?: string;
}) {
  const { t } = await getTranslation(lang);
  const Icon = kind === "empty" ? GitBranch : kind === "notFound" ? FolderSearch : ServerOff;
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border border-dashed px-6 py-12 text-center">
      <Icon className="size-10 text-muted-foreground" aria-hidden />
      <p className="font-medium">
        {kind === "unavailable" ? t("dashboard:repositories.errors.unavailable") : t(`dashboard:repositories.browser.${kind}Title`)}
      </p>
      {kind === "empty" && (
        <>
          <p className="max-w-md text-sm text-muted-foreground">{t("dashboard:repositories.browser.emptyDescription")}</p>
          {cloneUrl && <code className="max-w-full break-all rounded-md bg-muted px-2 py-1 text-xs">{cloneUrl}</code>}
        </>
      )}
      {kind === "notFound" && rootHref && (
        <Link prefetch={false} href={rootHref} className="text-sm underline underline-offset-4">{t("dashboard:repositories.browser.backToRoot")}</Link>
      )}
    </div>
  );
}
