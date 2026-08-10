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
  previousLabel,
  nextLabel,
}: {
  basePath: string;
  params?: Record<string, string | undefined>;
  currentPage: number;
  totalPages: number;
  // 表示は « / » の記号だけなので、支援技術向けの名前を別に渡す。
  previousLabel: string;
  nextLabel: string;
}) {
  if (totalPages <= 1) return null;

  const hasPrevious = currentPage > 1;
  const hasNext = currentPage < totalPages;

  return (
    <nav className="flex items-center justify-center gap-2">
      {hasPrevious ? (
        <Button variant="outline" size="sm" asChild>
          <Link
            href={buildHref(basePath, params, currentPage - 1)}
            aria-label={previousLabel}
          >
            <span aria-hidden="true">&laquo;</span>
          </Link>
        </Button>
      ) : (
        <Button variant="outline" size="sm" disabled aria-label={previousLabel}>
          <span aria-hidden="true">&laquo;</span>
        </Button>
      )}
      <span className="text-sm text-muted-foreground">
        {currentPage} / {totalPages}
      </span>
      {hasNext ? (
        <Button variant="outline" size="sm" asChild>
          <Link
            href={buildHref(basePath, params, currentPage + 1)}
            aria-label={nextLabel}
          >
            <span aria-hidden="true">&raquo;</span>
          </Link>
        </Button>
      ) : (
        <Button variant="outline" size="sm" disabled aria-label={nextLabel}>
          <span aria-hidden="true">&raquo;</span>
        </Button>
      )}
    </nav>
  );
}
