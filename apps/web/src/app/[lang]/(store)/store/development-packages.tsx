import Link from "next/link";
import { PackageOpen } from "lucide-react";
import { searchNugetPackages, sortNugetReleases, catalogMetadata } from "@beutl/api/nuget/catalog";
import { NUGET_ORIGIN } from "@beutl/core";
import { getTranslation } from "@beutl/i18n";
import { Button } from "@beutl/ui/ui/button";
import { Badge } from "@beutl/ui/ui/badge";
import { Card, CardContent } from "@beutl/ui/ui/card";

export async function DevelopmentPackages({ lang, query, page: requestedPage }: {
  lang: string;
  query?: string;
  page?: string;
}) {
  const { t } = await getTranslation(lang);
  const page = /^\d+$/u.test(requestedPage ?? "") ? Math.max(1, Math.min(5000, Number(requestedPage))) : 1;
  const { packages, totalHits } = await searchNugetPackages({ audience: "DEVELOPMENT", query, skip: (page - 1) * 20, take: 20 });
  const cards = (await Promise.all(packages.map(async (pkg) => {
    const latest = sortNugetReleases(pkg.Release)[0];
    const metadata = await catalogMetadata(pkg, latest);
    return metadata ? { pkg, latest, metadata } : null;
  }))).filter((card) => card !== null);
  const origin = (process.env.NUGET_PUBLIC_ORIGIN || NUGET_ORIGIN).replace(/\/$/u, "");
  const pageUrl = (n: number) => `/${lang}/store?${new URLSearchParams({ type: "development", query: query || "", page: String(n) })}`;
  return (
    <section className="px-2 space-y-6" aria-label={t("developer:nuget.title")}>
      <p className="max-w-2xl text-muted-foreground leading-relaxed">{t("developer:nuget.description")}</p>
      <div className="rounded-lg border bg-muted/30 p-4 text-sm space-y-2">
        <p className="font-medium">{t("developer:nuget.feed")}</p>
        <code className="block break-all text-muted-foreground">{origin}/v3/index.json</code>
      </div>
      <p className="text-sm text-muted-foreground">{totalHits.toLocaleString(lang)} {t("developer:nuget.packages")}</p>
      <div className="grid md:grid-cols-2 gap-4">
        {cards.map(({ pkg, latest, metadata }) => (
          <Link href={`/${lang}/packages/${encodeURIComponent(pkg.name)}`} key={pkg.id} className="group min-w-0">
            <Card className="h-full transition-colors group-hover:border-foreground/30">
              <CardContent className="p-6 space-y-4">
                <div className="flex gap-3 items-start"><div className="p-2.5 rounded-lg bg-secondary"><PackageOpen className="size-5" /></div>
                  <div className="min-w-0 space-y-1"><h2 className="font-semibold break-all">{pkg.name}</h2><Badge variant="secondary">{latest.version}</Badge></div>
                </div>
                <p className="text-sm text-muted-foreground line-clamp-3 leading-relaxed">{metadata.description}</p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"><span>{metadata.authors}</span>
                  <span>{pkg.Release.length} {t("developer:nuget.versions")}</span>
                  <span>{pkg.Release.reduce((n, r) => n + Number(r.downloads), 0).toLocaleString(lang)} {t("developer:nuget.downloads")}</span>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
      {!cards.length && <div className="rounded-lg border border-dashed text-muted-foreground text-center py-16">{t("developer:nuget.empty")}</div>}
      <nav className="flex justify-between" aria-label={t("developer:nuget.packages")}>
        {page > 1 ? <Button asChild variant="outline"><Link href={pageUrl(page - 1)}>{t("developer:nuget.previous")}</Link></Button> : <span />}
        {page * 20 < totalHits && <Button asChild variant="outline"><Link href={pageUrl(page + 1)}>{t("developer:nuget.next")}</Link></Button>}
      </nav>
    </section>
  );
}
