import { Badge } from "@beutl/ui/ui/badge";
import { Button } from "@beutl/ui/ui/button";
import { Card, CardContent } from "@beutl/ui/ui/card";
import { authOrSignIn } from "@/lib/auth-guard";
import { getTranslation } from "@beutl/i18n";
import { Eye, EyeOff } from "lucide-react";
import { retrievePackages } from "./actions";
import Link from "next/link";

export default async function Page(props: { params: Promise<{ lang: string }> }) {
  const { lang } = await props.params;
  await authOrSignIn();
  const { t } = await getTranslation(lang);
  const packages = await retrievePackages();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">{t("developer:portal.title")}</h1>
        <div className="flex gap-2">
          <Button asChild>
            <Link
              href={`/${lang}/dashboard/developer/new/project`}
              prefetch={false}
            >
              {t("developer:portal.createNewExtension")}
            </Link>
          </Button>
          <Button variant="outline" disabled>
            {t("developer:portal.documentation")}
          </Button>
        </div>
      </div>

      <div className="flex flex-col">
        <h2 className="text-lg font-semibold">
          {t("developer:portal.projects")}
        </h2>
        <div className="flex flex-wrap -mx-2 mt-2">
          {packages.map((item) => (
            <Link
              href={`/${lang}/dashboard/developer/projects/${item.name}`}
              prefetch={false}
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
                        <span className="text-muted-foreground">{item.name}</span>
                      </div>
                      {item.iconFileUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          className="flex-1 w-10 h-10 max-w-10 max-h-10 rounded-md"
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
