import { listUsers } from "@beutl/db";
import { getTranslation } from "@beutl/i18n";
import { UserSearchForm } from "./components";
import Link from "next/link";
import { Button } from "@beutl/ui/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beutl/ui/ui/table";
import { requireAdmin } from "@/lib/auth-guard";
import { fetchPaginated, parsePageParam } from "@/lib/pagination";

const PAGE_SIZE = 20;

export default async function Page(props: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  await requireAdmin();
  const params = await props.params;
  const { lang } = params;
  const searchParams = await props.searchParams;
  const { q, page } = searchParams;
  const { t } = await getTranslation(lang);

  const { result, currentPage, totalPages } = await fetchPaginated(
    (pageNumber) =>
      listUsers({ query: q, page: pageNumber, pageSize: PAGE_SIZE }),
    parsePageParam(page),
    PAGE_SIZE,
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t("admin:users.title")}</h1>
      </div>

      <UserSearchForm lang={lang} query={q} />

      {result.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("admin:users.noResults")}</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("admin:users.name")}</TableHead>
                <TableHead>{t("admin:users.email")}</TableHead>
                <TableHead>{t("admin:users.createdAt")}</TableHead>
                <TableHead className="text-right">{t("admin:users.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.items.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">{user.name || "-"}</TableCell>
                  <TableCell>{user.email}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {user.createdAt.toLocaleString(lang)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="outline" size="sm" asChild>
                      <Link href={`/${lang}/admin/users/${user.id}`}>
                        {t("admin:users.detail")}
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              {currentPage > 1 ? (
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/${lang}/admin/users?${new URLSearchParams({ q: q || "", page: String(currentPage - 1) })}`}>
                    &laquo;
                  </Link>
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled>
                  &laquo;
                </Button>
              )}
              <span className="text-sm text-muted-foreground">
                {currentPage} / {totalPages}
              </span>
              {currentPage < totalPages ? (
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/${lang}/admin/users?${new URLSearchParams({ q: q || "", page: String(currentPage + 1) })}`}>
                    &raquo;
                  </Link>
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled>
                  &raquo;
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
