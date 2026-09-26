import { ADMIN_PACKAGE_RELEASE_PAGE_SIZE, getPackageDetailForAdmin } from "@beutl/db";
import { formatAmount, formatBytes } from "@beutl/core";
import { getTranslation } from "@beutl/i18n";
import { Badge } from "@beutl/ui/ui/badge";
import { Button } from "@beutl/ui/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beutl/ui/ui/table";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth-guard";
import { formatTimestamp } from "@/lib/format";
import { PublishToggleButton } from "../components";
import { fetchPaginated, parsePageParam } from "@/lib/pagination";
import { Pagination } from "@/components/admin/pagination";

// 公開状態の切り替え直後に現在値を示す必要がある。
export const dynamic = "force-dynamic";

export default async function Page(props: {
  params: Promise<{ lang: string; id: string }>;
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  await requireAdmin();
  const { lang, id } = await props.params;
  const { t } = await getTranslation(lang);

  const { page } = await props.searchParams;

  // リリースのページが範囲外なら最終ページに丸めて取り直す。
  const { result: pkg, currentPage, totalPages } = await fetchPaginated(
    async (releasePage) => {
      const detail = await getPackageDetailForAdmin({ packageId: id, releasePage });
      return { detail, total: detail?._count.Release ?? 0 };
    },
    parsePageParam(page),
    ADMIN_PACKAGE_RELEASE_PAGE_SIZE,
  ).then(({ result, ...rest }) => ({ result: result.detail, ...rest }));
  if (!pkg) {
    notFound();
  }

  const releases = pkg.Release;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="mb-2">
          <Link href={`/${lang}/admin/packages`}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t("admin:users.back")}
          </Link>
        </Button>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">{pkg.displayName || pkg.name}</h1>
            <div className="font-mono text-sm text-muted-foreground">{pkg.name}</div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={pkg.published ? "default" : "secondary"}>
              {t(pkg.published ? "admin:users.publishedValue" : "admin:users.draftValue")}
            </Badge>
            <PublishToggleButton lang={lang} target="package" id={pkg.id} published={pkg.published} />
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{t("admin:packages.moderationNote")}</p>
      </div>

      <section className="rounded-lg border bg-card p-6">
        <h2 className="mb-4 text-lg font-semibold">{t("admin:packages.overview")}</h2>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">{t("admin:users.id")}</dt>
            <dd className="break-all font-mono">{pkg.id}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("admin:packages.owner")}</dt>
            <dd>
              <Link
                href={`/${lang}/admin/users/${pkg.user.id}`}
                className="underline-offset-4 hover:underline"
              >
                {pkg.user.name || pkg.user.email}
              </Link>
              <span className="ml-2 text-xs text-muted-foreground">{pkg.user.email}</span>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("admin:users.createdAt")}</dt>
            <dd>{formatTimestamp(pkg.createdAt, lang)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("admin:packages.updatedAt")}</dt>
            <dd>{formatTimestamp(pkg.updatedAt, lang)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("admin:packages.libraryCount")}</dt>
            <dd>{pkg._count.UserPackage}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("admin:packages.webSite")}</dt>
            <dd className="break-all">{pkg.webSite || "-"}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-muted-foreground">{t("admin:packages.tags")}</dt>
            <dd className="flex flex-wrap gap-1">
              {pkg.tags.length === 0
                ? "-"
                : pkg.tags.map((tag) => <Badge key={tag} variant="outline">{tag}</Badge>)}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-muted-foreground">{t("admin:packages.shortDescription")}</dt>
            <dd>{pkg.shortDescription || "-"}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-muted-foreground">{t("admin:packages.description")}</dt>
            <dd className="max-h-64 overflow-auto whitespace-pre-wrap rounded border bg-muted/30 p-3">
              {pkg.description || "-"}
            </dd>
          </div>
        </dl>
      </section>

      <section className="rounded-lg border bg-card p-6">
        <h2 className="mb-4 text-lg font-semibold">{t("admin:packages.pricing")}</h2>
        <p className="mb-3 text-sm">
          <span className="text-muted-foreground">{t("admin:packages.interval")}: </span>
          {pkg.interval ?? "-"}
        </p>
        {pkg.packagePricing.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("admin:packages.free")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("admin:packages.currency")}</TableHead>
                <TableHead className="text-right">{t("admin:packages.price")}</TableHead>
                <TableHead>{t("admin:packages.fallback")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pkg.packagePricing.map((pricing) => (
                <TableRow key={pricing.id}>
                  <TableCell className="font-mono uppercase">{pricing.currency}</TableCell>
                  <TableCell className="text-right font-mono">
                    {/* price は Stripe の最小通貨単位。ストアと同じ書式で見せる。 */}
                    {formatAmount(pricing.price, pricing.currency, lang)}
                  </TableCell>
                  <TableCell>{pricing.fallback ? "✓" : ""}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="rounded-lg border bg-card p-6">
        <h2 className="mb-4 text-lg font-semibold">{t("admin:packages.releases")}</h2>
        {releases.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("admin:common.empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("admin:packages.version")}</TableHead>
                  <TableHead>{t("admin:packages.releaseTitle")}</TableHead>
                  <TableHead>{t("admin:packages.targetVersion")}</TableHead>
                  <TableHead>{t("admin:packages.file")}</TableHead>
                  <TableHead>{t("admin:users.createdAt")}</TableHead>
                  <TableHead>{t("admin:packages.published")}</TableHead>
                  <TableHead className="text-right">{t("admin:users.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {releases.map((release) => (
                  <TableRow key={release.id}>
                    <TableCell className="font-mono">{release.version}</TableCell>
                    <TableCell>{release.title}</TableCell>
                    <TableCell className="font-mono">{release.targetVersion}</TableCell>
                    <TableCell className="text-xs">
                      {release.file
                        ? `${release.file.name} (${formatBytes(Number(release.file.size))})`
                        : "-"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatTimestamp(release.createdAt, lang)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={release.published ? "default" : "secondary"}>
                        {t(release.published ? "admin:users.publishedValue" : "admin:users.draftValue")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <PublishToggleButton
                        lang={lang}
                        target="release"
                        id={release.id}
                        published={release.published}
                        // 公開はファイルが付いているリリースに限る (サーバー側でも拒否する)。
                        disabled={!release.published && !release.file}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="mt-3">
              <Pagination
                basePath={`/${lang}/admin/packages/${pkg.id}`}
                currentPage={currentPage}
                totalPages={totalPages}
                previousLabel={t("admin:common.previousPage")}
                nextLabel={t("admin:common.nextPage")}
              />
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
