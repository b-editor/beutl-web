"use client";

import { useEffect } from "react";
import { useParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@beutl/ui/ui/card";
import { Button } from "@beutl/ui/ui/button";
import { useTranslation } from "@beutl/ui/i18n-client";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { lang } = useParams<{ lang: string }>() ?? { lang: "ja" };
  const { t } = useTranslation(lang);

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="h-screen flex items-center justify-center">
      <Card className="w-[350px]">
        <CardHeader>
          <CardTitle>{t("somethingWentWrong")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-muted-foreground">
            {t("somethingWentWrongDescription")}
          </p>
          <Button onClick={() => reset()} className="w-full">
            {t("tryAgain")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
