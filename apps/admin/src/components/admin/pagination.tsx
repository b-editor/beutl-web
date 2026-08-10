import Link from "next/link";
import { Button } from "@beutl/ui/ui/button";

function buildHref(
  basePath: string,
  params: Record<string, string | undefined>,
  page: number,
) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  search.set("page", String(page));
  return `${basePath}?${search.toString()}`;
}

export function Pagination({
  basePath,
  params = {},
  currentPage,
  totalPages,
}: {
  basePath: string;
  params?: Record<string, string | undefined>;
  currentPage: number;
  totalPages: number;
}) {
  if (totalPages <= 1) return null;

  const hasPrevious = currentPage > 1;
  const hasNext = currentPage < totalPages;

  return (
    <div className="flex items-center justify-center gap-2">
      <Button variant="outline" size="sm" asChild={hasPrevious} disabled={!hasPrevious}>
        {hasPrevious ? (
          <Link href={buildHref(basePath, params, currentPage - 1)}>&laquo;</Link>
        ) : (
          <span>&laquo;</span>
        )}
      </Button>
      <span className="text-sm text-muted-foreground">
        {currentPage} / {totalPages}
      </span>
      <Button variant="outline" size="sm" asChild={hasNext} disabled={!hasNext}>
        {hasNext ? (
          <Link href={buildHref(basePath, params, currentPage + 1)}>&raquo;</Link>
        ) : (
          <span>&raquo;</span>
        )}
      </Button>
    </div>
  );
}
