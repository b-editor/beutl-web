import Link from "next/link";
import { ChevronRight } from "lucide-react";

/**
 * リポジトリ名から現在のディレクトリまでのパンくず。
 * 途中のセグメントはディレクトリなので tree/ に、リポジトリ名はルートに戻す。
 */
export function Breadcrumbs({
  base,
  path,
  repo,
}: {
  base: string;
  path: string;
  repo: string;
}) {
  const segments = path.split("/").filter(Boolean);

  return (
    <nav className="flex flex-wrap items-center gap-1 text-sm">
      <Link href={base} className="font-medium hover:underline">
        {repo}
      </Link>
      {segments.map((segment, index) => {
        const isLast = index === segments.length - 1;
        const href = `${base}/tree/${segments.slice(0, index + 1).join("/")}`;
        return (
          <span key={href} className="flex items-center gap-1">
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            {isLast ? (
              <span className="text-muted-foreground">{segment}</span>
            ) : (
              <Link href={href} className="hover:underline">
                {segment}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
