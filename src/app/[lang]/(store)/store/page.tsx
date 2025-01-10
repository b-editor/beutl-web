import { getTranslation } from "@/app/i18n/server";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { formatAmount } from "@/lib/currency-formatter";
import { retrievePackages } from "@/lib/store-utils";
import Image from "next/image";

export default async function Page({
  searchParams: { query },
  params: { lang },
}: {
  searchParams: { query?: string };
  params: { lang: string };
}) {
  const { t } = await getTranslation(lang);
  const packages = await retrievePackages(query);

  return (
    <>
      <div className="border-b bg-card">
        <div className="container max-w-6xl mx-auto py-6 flex flex-col">
          <h2 className="text-3xl font-semibold mx-4">
            {t("store:searchForExtensions")}
          </h2>
          <form method="GET">
            <Input
              name="query"
              className="my-4 mx-4 max-md:w-auto md:max-w-md"
              type="search"
              placeholder={t("store:search")}
              defaultValue={query}
            />
          </form>
        </div>
      </div>
      <div className="container max-w-6xl mx-auto py-6 px-2">
        <div className="flex flex-wrap">
          {packages.map((item) => (
            <a
              href={`/${lang}/store/${item.name}`}
              className="text-start p-2 basis-full sm:basis-1/2 md:basis-1/3"
              key={item.id}
            >
              <Card className="h-full">
                <CardContent className="p-6 h-full flex flex-col gap-2 justify-between">
                  <div>
                    <div className="flex w-full">
                      <div className="flex-[3]">
                        <h4 className="text-xl font-semibold">
                          {item.displayName || item.name}
                        </h4>
                        <span className="text-muted">{item.userName}</span>
                      </div>
                      {item.iconFileUrl && (
                        <Image
                          width={64}
                          height={64}
                          className="flex-1 w-16 h-16 max-w-fit rounded-md"
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
                      <Separator
                        orientation="vertical"
                        className="h-auto my-1"
                      />
                      {item.tags.map((tag) => (
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
            </a>
          ))}
        </div>
      </div>
    </>
  );
}
