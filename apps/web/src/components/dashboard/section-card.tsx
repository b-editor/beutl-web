import { cn } from "@beutl/core";
import { Card } from "@beutl/ui/ui/card";
import { Separator } from "@beutl/ui/ui/separator";

// ダッシュボードの設定系ページで繰り返されている「見出し + 区切り線 + 本文」の
// カード。account 配下の各ページが同じマークアップを手書きしているので、
// まず請求ページをここに寄せ、残りは順次移していく。
export function SectionCard({
  title,
  description,
  headerAction,
  flush,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  headerAction?: React.ReactNode;
  // 本文の左右パディングを外す。Table のようにセル側が余白を持つ子で使う。
  flush?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-4 p-6 pb-4">
        <div className="min-w-0">
          <h2 className="text-md font-bold">{title}</h2>
          {description && (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {headerAction}
      </div>
      {children != null && (
        <>
          <Separator />
          <div className={cn(!flush && "px-6 py-4")}>{children}</div>
        </>
      )}
    </Card>
  );
}
