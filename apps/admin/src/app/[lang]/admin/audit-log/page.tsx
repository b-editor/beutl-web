import { listAuditLogs } from "@beutl/db";
import { getTranslation } from "@beutl/i18n";
import { AuditLogFilterForm } from "./filter";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beutl/ui/ui/table";
import { requireAdmin } from "@/lib/auth-guard";

const PAGE_SIZE = 30;

export default async function Page(props: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{ action?: string; userId?: string; page?: string }>;
}) {
  await requireAdmin();
  const params = await props.params;
  const { lang } = params;
  const searchParams = await props.searchParams;
  const { action, userId, page } = searchParams;
  const { t } = await getTranslation(lang);

  const currentPage = Math.max(1, Number(page) || 1);
  const result = await listAuditLogs({
    action: action || undefined,
    userId: userId || undefined,
    page: currentPage,
    pageSize: PAGE_SIZE,
  });

  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));

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
                      <a
                        href={`/${lang}/admin/users/${log.userId}`}
                        className="hover:underline"
                      >
                        {log.userId}
                      </a>
                    ) : (
                      "-"
                    )}
                  </TableCell>
                  <TableCell className="max-w-md truncate" title={log.details || ""}>
                    {log.details || "-"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{log.ipAddress || "-"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {log.createdAt.toLocaleString(lang)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <a
                href={`/${lang}/admin/audit-log?${new URLSearchParams({
                  action: action || "",
                  userId: userId || "",
                  page: String(Math.max(1, currentPage - 1)),
                })}`}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                &laquo;
              </a>
              <span className="text-sm text-muted-foreground">
                {currentPage} / {totalPages}
              </span>
              <a
                href={`/${lang}/admin/audit-log?${new URLSearchParams({
                  action: action || "",
                  userId: userId || "",
                  page: String(Math.min(totalPages, currentPage + 1)),
                })}`}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                &raquo;
              </a>
            </div>
          )}
        </>
      )}
    </div>
  );
}
