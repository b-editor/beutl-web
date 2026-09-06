import { Badge } from "@beutl/ui/ui/badge";
import { Card, CardContent } from "@beutl/ui/ui/card";
import { Separator } from "@beutl/ui/ui/separator";
import { formatAmount, visiblePackageTags } from "@beutl/core";
import Link from "next/link";
import type { ListedPackage } from "./actions";

// ライブラリ一覧と概要ページで同じカードを使う。
export function LibraryPackageCard({
  item,
  lang,
  freeLabel,
}: {
  item: ListedPackage;
  lang: string;
  freeLabel: string;
}) {
  const tags = visiblePackageTags(item.tags);

  return (
    <Link
      href={`/${lang}/store/${item.name}`}
      prefetch={false}
      className="text-start p-2 basis-full sm:basis-1/2 md:basis-1/3 min-w-0"
    >
      <Card className="h-full">
        <CardContent className="p-6 h-full flex flex-col gap-2 justify-between">
          <div>
            <div className="flex w-full gap-2">
              <div className="flex-3 min-w-0">
                <h3 className="text-xl font-semibold truncate">
                  {item.displayName || item.name}
                </h3>
                <span className="text-muted-foreground truncate block">
                  {item.userName}
                </span>
              </div>
              {item.iconFileUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  className="w-16 h-16 max-w-16 max-h-16 rounded-md"
                  alt="Package icon"
                  src={item.iconFileUrl}
                />
              ) : (
                <div className="w-16 h-16 shrink-0 rounded-md bg-secondary" />
              )}
            </div>
            <p className="text-sm mt-2">{item.shortDescription}</p>
          </div>
          <div className="overflow-x-clip relative h-6">
            <div className="flex gap-2 absolute">
              <Badge variant="secondary" className="text-nowrap">
                {item.price
                  ? formatAmount(item.price.price, item.price.currency, lang)
                  : freeLabel}
              </Badge>
              {tags.length > 0 && (
                <Separator orientation="vertical" className="h-auto my-1" />
              )}
              {tags.map((tag) => (
                <Badge
                  variant="outline"
                  className="border-input text-nowrap"
                  key={tag}
                >
                  {tag}
                </Badge>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
