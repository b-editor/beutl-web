import { listFeedback } from "@beutl/db";
import { getTranslation } from "@beutl/i18n";
import { FeedbackStatusSelect } from "./components";
import { FeedbackFilterForm } from "./filter";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beutl/ui/ui/table";
import { Badge } from "@beutl/ui/ui/badge";

const PAGE_SIZE = 20;

export default async function Page(props: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{ status?: string; category?: string; page?: string }>;
}) {
  const params = await props.params;
  const { lang } = params;
  const searchParams = await props.searchParams;
  const { status, category, page } = searchParams;
  const { t } = await getTranslation(lang);

  const currentPage = Math.max(1, Number(page) || 1);
  const result = await listFeedback({
    status: status as "OPEN" | "IN_PROGRESS" | "RESOLVED" | undefined,
    category: category as "BUG_REPORT" | "FEATURE_REQUEST" | "QUESTION" | "OTHER" | undefined,
    page: currentPage,
    pageSize: PAGE_SIZE,
  });

  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t("admin:feedback.title")}</h1>
      </div>

      <FeedbackFilterForm lang={lang} status={status} category={category} />

      {result.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("admin:feedback.noResults")}</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("admin:feedback.status")}</TableHead>
                <TableHead>{t("admin:feedback.category")}</TableHead>
                <TableHead>{t("admin:feedback.name")}</TableHead>
                <TableHead>{t("admin:feedback.message")}</TableHead>
                <TableHead>{t("admin:feedback.createdAt")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <FeedbackStatusSelect
                      lang={lang}
                      feedbackId={item.id}
                      initialStatus={item.status}
                    />
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{t(`admin:category.${item.category}`)}</Badge>
                  </TableCell>
                  <TableCell>{item.name}</TableCell>
                  <TableCell className="max-w-md truncate" title={item.message}>
                    {item.message}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {item.createdAt.toLocaleString(lang)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <a
                href={`/${lang}/admin/feedback?${new URLSearchParams({
                  status: status || "",
                  category: category || "",
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
                href={`/${lang}/admin/feedback?${new URLSearchParams({
                  status: status || "",
                  category: category || "",
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
