import { listAuditLogs } from "@beutl/db";
import { formatTimestamp } from "@/lib/format";
import { getTranslation } from "@beutl/i18n";
import { AuditLogFilterForm } from "./filter";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beutl/ui/ui/table";
import { requireAdmin } from "@/lib/auth-guard";
import { fetchPaginated, parsePageParam } from "@/lib/pagination";
import { firstSearchParam } from "@/lib/search-params";
import { Pagination } from "@/components/admin/pagination";
import Link from "next/link";

const PAGE_SIZE = 30;

export default async function Page(props: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{
    action?: string | string[];
    userId?: string | string[];
    page?: string | string[];
  }>;
}) {
  await requireAdmin();
  const params = await props.params;
  const { lang } = params;
  const searchParams = await props.searchParams;
  const action = firstSearchParam(searchParams.action);
  const userId = firstSearchParam(searchParams.userId);
  const { page } = searchParams;
  const { t } = await getTranslation(lang);

  const { result, currentPage, totalPages } = await fetchPaginated(
    (pageNumber) =>
      listAuditLogs({
        action: action || undefined,
        userId: userId || undefined,
        page: pageNumber,
        pageSize: PAGE_SIZE,
      }),
    parsePageParam(page),
    PAGE_SIZE,
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t("admin:auditLog.title")}</h1>
      </div>

      <AuditLogFilterForm lang={lang} action={action} userId={userId} />

      {result.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("admin:auditLog.noResults")}</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("admin:auditLog.action")}</TableHead>
                <TableHead>{t("admin:auditLog.userId")}</TableHead>
                <TableHead>{t("admin:auditLog.details")}</TableHead>
                <TableHead>{t("admin:auditLog.ipAddress")}</TableHead>
                <TableHead>{t("admin:auditLog.createdAt")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.items.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="font-mono text-xs">{log.action}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {log.userId ? (
                      <Link
                        href={`/${lang}/admin/users/${log.userId}`}
                        className="hover:underline"
                      >
                        {log.userId}
                      </Link>
                    ) : (
                      "-"
                    )}
                  </TableCell>
                  <TableCell className="max-w-md truncate" title={log.details || ""}>
                    {log.details || "-"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{log.ipAddress || "-"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatTimestamp(log.createdAt, lang)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <Pagination
            basePath={`/${lang}/admin/audit-log`}
            params={{ action, userId }}
            currentPage={currentPage}
            totalPages={totalPages}
          />
        </>
      )}
    </div>
  );
}
