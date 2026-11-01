import { Separator } from "@beutl/ui/ui/separator";
import { getTranslation } from "@beutl/i18n";
import { EyeOff } from "lucide-react";
import type { Package } from "./types";

// 編集フォームの脇に置く読み取り専用の欄。合計を大きく出し、その下に
// バージョン別の内訳を新しい順に並べる。非公開にしたリリースも、公開中に
// 数えた分が残るので一覧から外さない。
export async function PackageDownloads({
  pkg,
  lang,
}: { pkg: Package; lang: string }) {
  const { t } = await getTranslation(lang);
  const releases = pkg.releaseDownloads;
  const total = releases.reduce((sum, release) => sum + release.downloads, 0);

  return (
    <div>
      <h4 className="font-bold text-lg mt-6 border-b pb-2">
        {t("developer:downloads.title")}
      </h4>
      <div className="flex flex-col gap-1 my-4">
        <p className="text-3xl font-bold tabular-nums">
          {total.toLocaleString(lang)}
        </p>
        <p className="text-sm text-muted-foreground">
          {t("developer:downloads.total")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("developer:downloads.since")}
        </p>
      </div>
      <Separator />
      {releases.length > 0 && (
        <>
          <dl className="flex flex-col gap-2 my-4 text-sm max-h-80 overflow-y-auto">
            {releases.map((release) => (
              <div key={release.id} className="flex justify-between gap-4">
                <dt className="flex items-center gap-1.5 min-w-0 break-all">
                  {release.version}
                  {!release.published && (
                    <span
                      className="inline-flex text-muted-foreground"
                      title={t("developer:downloads.unpublished")}
                    >
                      <EyeOff className="w-3.5 h-3.5" aria-hidden />
                      <span className="sr-only">
                        {t("developer:downloads.unpublished")}
                      </span>
                    </span>
                  )}
                </dt>
                <dd className="tabular-nums text-muted-foreground">
                  {release.downloads.toLocaleString(lang)}
                </dd>
              </div>
            ))}
          </dl>
          <Separator />
        </>
      )}
    </div>
  );
}
