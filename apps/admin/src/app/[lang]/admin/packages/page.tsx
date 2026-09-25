import { listPackagesForAdmin } from "@beutl/db";
import { getTranslation } from "@beutl/i18n";
import { Badge } from "@beutl/ui/ui/badge";
import { Button } from "@beutl/ui/ui/button";
import { Input } from "@beutl/ui/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beutl/ui/ui/table";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth-guard";
import { formatTimestamp } from "@/lib/format";
import { fetchPaginated, parsePageParam } from "@/lib/pagination";
import { firstSearchParam } from "@/lib/search-params";
import { Pagination } from "@/components/admin/pagination";

const PAGE_SIZE = 30;
const PUBLISHED_FILTERS = ["published", "draft"] as const;

export default async function Page(props: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{
    q?: string | string[];
    published?: string | string[];
    page?: string | string[];
  }>;
}) {
  await requireAdmin();
  const { lang } = await props.params;
  const searchParams = await props.searchParams;
  const q = firstSearchParam(searchParams.q)?.trim().slice(0, 200) || undefined;
  const publishedFilter = PUBLISHED_FILTERS.find(
    (value) => value === firstSearchParam(searchParams.published),
  );
  const { t } = await getTranslation(lang);

  const { result, currentPage, totalPages } = await fetchPaginated(
    (pageNumber) =>
      listPackagesForAdmin({
        query: q,
        published: publishedFilter === undefined ? undefined : publishedFilter === "published",
        page: pageNumber,
        pageSize: PAGE_SIZE,
      }),
    parsePageParam(searchParams.page),
    PAGE_SIZE,
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">{t("admin:packages.title")}</h1>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-2">
        <Input
          type="search"
          name="q"
          defaultValue={q}
          maxLength={200}
          placeholder={t("admin:packages.searchPlaceholder")}
          aria-label={t("admin:packages.searchPlaceholder")}
          className="max-w-sm"
        />
        <select
          name="published"
          defaultValue={publishedFilter ?? ""}
          aria-label={t("admin:packages.published")}
          className="h-9 rounded-md border bg-background px-3 text-sm"
        >
          <option value="">{t("admin:packages.allStates")}</option>
          <option value="published">{t("admin:users.publishedValue")}</option>
          <option value="draft">{t("admin:users.draftValue")}</option>
        </select>
        <Button type="submit" variant="outline">{t("admin:users.search")}</Button>
      </form>

      {result.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("admin:common.empty")}</p>
      ) : (
        <>
          <div className="rounded-md border">
            <Table className="min-w-[800px]">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("admin:users.packageName")}</TableHead>
                  <TableHead>{t("admin:packages.owner")}</TableHead>
                  <TableHead>{t("admin:packages.published")}</TableHead>
                  <TableHead className="text-right">{t("admin:packages.releaseCount")}</TableHead>
                  <TableHead className="text-right">{t("admin:packages.libraryCount")}</TableHead>
                  <TableHead>{t("admin:packages.updatedAt")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.items.map((pkg) => (
                  <TableRow key={pkg.id}>
                    <TableCell>
                      <Link
                        href={`/${lang}/admin/packages/${pkg.id}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {pkg.displayName || pkg.name}
                      </Link>
                      <div className="font-mono text-xs text-muted-foreground">{pkg.name}</div>
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/${lang}/admin/users/${pkg.user.id}`}
                        className="text-sm underline-offset-4 hover:underline"
                      >
                        {pkg.user.name || pkg.user.email}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={pkg.published ? "default" : "secondary"}>
                        {t(pkg.published ? "admin:users.publishedValue" : "admin:users.draftValue")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{pkg._count.Release}</TableCell>
                    <TableCell className="text-right">{pkg._count.UserPackage}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatTimestamp(pkg.updatedAt, lang)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <Pagination
            basePath={`/${lang}/admin/packages`}
            params={{ q, published: publishedFilter }}
            currentPage={currentPage}
            totalPages={totalPages}
            previousLabel={t("admin:common.previousPage")}
            nextLabel={t("admin:common.nextPage")}
          />
        </>
      )}
    </div>
  );
}
