import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { authOrSignIn } from "@/lib/auth-guard";
import { Eye, EyeOff } from "lucide-react";
import Image from "next/image";
import { retrievePackages } from "./actions";
import Link from "next/link";

export default async function Page() {
  await authOrSignIn();
  const packages = await retrievePackages();

  return (
    <div>
      <div className="border-b bg-card">
        <div className="container max-w-6xl mx-auto py-12 px-4 flex flex-col gap-12">
          <h2 className="text-3xl font-semibold">拡張機能を開発する</h2>
          <div className="flex gap-2">
            <Button asChild>
              <Link href="/developer/new/project">新しい拡張機能を作成</Link>
            </Button>
            <Button variant="outline" disabled>
              ドキュメント
            </Button>
          </div>
        </div>
      </div>

      <div className="container max-w-6xl mx-auto py-12 px-4 flex flex-col">
        <h2 className="text-xl font-semibold">プロジェクト</h2>
        <div className="flex flex-wrap -mx-2">
          {packages.map((item) => (
            <Link
              href={`/developer/projects/${item.name}`}
              className="text-start p-2 basis-full md:basis-1/2 lg:basis-1/3 min-w-0"
              key={item.name}
            >
              <Card className="h-full">
                <CardContent className="p-6 h-full flex flex-col gap-2 justify-between">
                  <div>
                    <div className="flex w-full">
                      <div className="flex-3 overflow-hidden">
                        <h4 className="text-xl font-semibold">
                          {item.displayName || item.name}
                        </h4>
                        <span className="text-muted">{item.name}</span>
                      </div>
                      {item.iconFileUrl && (
                        <Image
                          width={40}
                          height={40}
                          className="flex-1 w-10 h-10 max-w-fit rounded-md"
                          alt="Package icon"
                          src={item.iconFileUrl}
                        />
                      )}

                      {!item.iconFileUrl && (
                        <div className="w-10 h-10 rounded-md bg-secondary" />
                      )}
                    </div>
                    <div className="mt-4 flex gap-2">
                      {item.latestVersion && (
                        <Badge variant="secondary">{item.latestVersion}</Badge>
                      )}
                      <Badge variant="secondary">
                        {item.published ? (
                          <Eye className="w-4 h-4" />
                        ) : (
                          <EyeOff className="w-4 h-4" />
                        )}
                      </Badge>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
