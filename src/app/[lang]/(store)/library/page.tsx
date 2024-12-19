import { authOrSignIn } from "@/lib/auth-guard";
import { retrievePackages } from "./actions";
import { Card, CardContent } from "@/components/ui/card";
import Image from "next/image";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { formatAmount } from "@/lib/currency-formatter";

export default async function Page({ params: { lang } }: { params: { lang: string } }) {
  const session = await authOrSignIn();
  const packages = await retrievePackages(session.user.id);

  return (
    <div className="container max-w-6xl mx-auto px-2">
      <h2 className="text-3xl font-semibold mx-4 py-6">ライブラリ</h2>
      <div className="flex flex-wrap">
        {packages.map(item => (
          <a href={`/store/${item.name}`} className="text-start p-2 basis-full sm:basis-1/2 md:basis-1/3" key={item.id}>
            <Card className="h-full">
              <CardContent className="p-6 h-full flex flex-col gap-2 justify-between">
                <div>
                  <div className="flex w-full">
                    <div className="flex-[3]">
                      <h4 className="text-xl font-semibold">{item.displayName || item.name}</h4>
                      <span className="text-muted">{item.userName}</span>
                    </div>
                    {item.iconFileUrl && <Image width={64} height={64}
                      className="flex-1 w-16 h-16 max-w-fit rounded-md"
                      alt="Package icon" src={item.iconFileUrl} />}
                    {!item.iconFileUrl && <div className="w-16 h-16 rounded-md bg-secondary" />}
                  </div>
                  <p className="text-sm mt-2">{item.shortDescription}</p>
                </div>
                <div className="overflow-x-clip relative h-6">
                  <div className="flex gap-2 absolute">
                    <Badge variant="secondary" className="text-nowrap">
                      {item.price ? formatAmount(item.price.price, item.price.currency, lang) : "無料"}
                    </Badge>
                    <Separator orientation="vertical" className="h-auto my-1" />
                    {item.tags.map(tag => (
                      <Badge variant="outline" className="border-input text-nowrap" key={tag}>{tag}</Badge>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          </a>
        ))}
      </div>
    </div>
  )
}