import { isFeedbackCategory, isFeedbackStatus, listFeedback } from "@beutl/db";
import { formatTimestamp } from "@/lib/format";
import { getTranslation } from "@beutl/i18n";
import { FeedbackStatusSelect } from "./components";
import { FeedbackFilterForm } from "./filter";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beutl/ui/ui/table";
import { Badge } from "@beutl/ui/ui/badge";
import { requireAdmin } from "@/lib/auth-guard";
import { fetchPaginated, parsePageParam } from "@/lib/pagination";
import { firstSearchParam } from "@/lib/search-params";
import { Pagination } from "@/components/admin/pagination";

const PAGE_SIZE = 20;

export default async function Page(props: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{
    status?: string | string[];
    category?: string | string[];
    page?: string | string[];
  }>;
}) {
  await requireAdmin();
  const params = await props.params;
  const { lang } = params;
  const searchParams = await props.searchParams;
  const status = firstSearchParam(searchParams.status);
  const category = firstSearchParam(searchParams.category);
  const { page } = searchParams;
  const { t } = await getTranslation(lang);
  const statusFilter = isFeedbackStatus(status) ? status : undefined;
  const categoryFilter = isFeedbackCategory(category) ? category : undefined;

  const { result, currentPage, totalPages } = await fetchPaginated(
    (pageNumber) =>
      listFeedback({
        status: statusFilter,
        category: categoryFilter,
        page: pageNumber,
        pageSize: PAGE_SIZE,
      }),
    parsePageParam(page),
    PAGE_SIZE,
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t("admin:feedback.title")}</h1>
      </div>

      <FeedbackFilterForm lang={lang} status={statusFilter} category={categoryFilter} />

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
                <TableHead>{t("admin:feedback.email")}</TableHead>
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
                  <TableCell>
                    <a
                      href={`mailto:${item.email}`}
                      className="text-sm underline-offset-4 hover:underline"
                    >
                      {item.email}
                    </a>
                  </TableCell>
                  <TableCell className="max-w-md truncate" title={item.message}>
                    {item.message}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatTimestamp(item.createdAt, lang)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <Pagination
            basePath={`/${lang}/admin/feedback`}
            params={{ status: statusFilter, category: categoryFilter }}
            currentPage={currentPage}
            totalPages={totalPages}
          />
        </>
      )}
    </div>
  );
}
