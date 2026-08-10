import { getTranslation } from "@beutl/i18n";
import { Badge } from "@beutl/ui/ui/badge";
import { Card, CardContent } from "@beutl/ui/ui/card";
import { Input } from "@beutl/ui/ui/input";
import { Separator } from "@beutl/ui/ui/separator";
import {
  cn,
  formatAmount,
  isPackageTypeFilter,
  PACKAGE_TYPE_FILTERS,
  visiblePackageTags,
} from "@beutl/core";
import type { PackageTypeFilter } from "@beutl/core";
import { retrievePackages } from "@/lib/store-utils";
import Link from "next/link";

const TYPE_FILTER_LABEL_KEYS: Record<PackageTypeFilter, string> = {
  all: "store:typeAll",
  extension: "store:typeExtensions",
  material: "store:typeMaterials",
  template: "store:typeTemplates",
};

export default async function Page(
  props: {
    searchParams: Promise<{ query?: string; type?: string }>;
    params: Promise<{ lang: string }>;
  }
) {
  const params = await props.params;

  const {
    lang
  } = params;

  const searchParams = await props.searchParams;

  const {
    query
  } = searchParams;

  const type = isPackageTypeFilter(searchParams.type) ? searchParams.type : "all";

  const { t } = await getTranslation(lang);
  const packages = await retrievePackages(query, type);

  return (
    <>
      <div className="border-b bg-card">
        <div className="container max-w-6xl mx-auto py-6 flex flex-col">
          <h2 className="text-3xl font-semibold mx-4">
            {t("store:searchForPackages")}
          </h2>
          <form method="GET">
            {/* The tabs below are links, so the current filter has to ride along
                with a new search or submitting the box would reset it to "all". */}
            <input type="hidden" name="type" value={type} />
            <Input
              name="query"
              className="my-4 mx-4 max-md:w-auto md:max-w-md"
              type="search"
              placeholder={t("store:search")}
              defaultValue={query}
            />
          </form>
          <div className="flex gap-1 mx-4 flex-wrap">
            {PACKAGE_TYPE_FILTERS.map((filter) => {
              const next = new URLSearchParams();
              if (query) next.set("query", query);
              if (filter !== "all") next.set("type", filter);
              const search = next.toString();

              return (
                <Link
                  key={filter}
                  href={`/${lang}/store${search ? `?${search}` : ""}`}
                  aria-current={filter === type ? "page" : undefined}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-sm transition-colors",
                    filter === type
                      ? "border-input bg-secondary font-semibold"
                      : "border-transparent text-muted-foreground hover:bg-secondary/50",
                  )}
                >
                  {t(TYPE_FILTER_LABEL_KEYS[filter])}
                </Link>
              );
            })}
          </div>
        </div>
      </div>
      <div className="container max-w-6xl mx-auto py-6 px-2">
        <div className="flex flex-wrap">
          {packages.map((item) => {
            const tags = visiblePackageTags(item.tags);

            return (
            <Link
              href={`/${lang}/store/${item.name}`}
              className="text-start p-2 basis-full sm:basis-1/2 md:basis-1/3"
              key={item.id}
            >
              <Card className="h-full">
                <CardContent className="p-6 h-full flex flex-col gap-2 justify-between">
                  <div>
                    <div className="flex w-full">
                      <div className="flex-3">
                        <h4 className="text-xl font-semibold">
                          {item.displayName || item.name}
                        </h4>
                        <span className="text-muted-foreground">{item.userName}</span>
                      </div>
                      {item.iconFileUrl && (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          className="flex-1 w-16 h-16 max-w-16 max-h-16 rounded-md"
                          alt="Package icon"
                          src={item.iconFileUrl}
                        />
                      )}
                      {!item.iconFileUrl && (
                        <div className="w-16 h-16 rounded-md bg-secondary" />
                      )}
                    </div>
                    <p className="text-sm mt-2">{item.shortDescription}</p>
                  </div>
                  <div className="overflow-x-clip relative h-6">
                    <div className="flex gap-2 absolute">
                      <Badge variant="secondary" className="text-nowrap">
                        {item.price
                          ? formatAmount(
                            item.price.price,
                            item.price.currency,
                            lang,
                          )
                          : t("store:free")}
                      </Badge>
                      {tags.length > 0 && (
                        <Separator
                          orientation="vertical"
                          className="h-auto my-1"
                        />
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
          })}
        </div>
      </div>
    </>
  );
}
