"use client";

import { useState, useTransition } from "react";
import { useTranslation } from "@beutl/ui/i18n-client";
import { Button } from "@beutl/ui/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@beutl/ui/ui/card";
import { Input } from "@beutl/ui/ui/input";
import { Label } from "@beutl/ui/ui/label";
import { KeyRound } from "lucide-react";
import { issueCredentialAction } from "./actions";
import type { CredentialResult } from "./actions";

export function CredentialsCard({
  lang,
  username,
}: {
  lang: string;
  username: string;
}) {
  const { t } = useTranslation(lang);
  const [pending, startTransition] = useTransition();
  const [credential, setCredential] = useState<CredentialResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const issue = () => {
    startTransition(async () => {
      const result = await issueCredentialAction();
      if (result.success && result.data) {
        setCredential(result.data);
        setError(null);
      } else {
        setCredential(null);
        setError(result.message ?? t("repositories:errors.unknown"));
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4" />
          {t("repositories:credentials")}
        </CardTitle>
        <CardDescription>
          {t("repositories:credentialsDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="git-username">{t("repositories:username")}</Label>
          <Input id="git-username" value={username} readOnly />
        </div>

        {credential ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="git-token">{t("repositories:token")}</Label>
            {/* 平文はこの 1 回しか受け取れない。再読み込みすると消える。 */}
            <Input id="git-token" value={credential.token} readOnly />
            <p className="text-sm text-muted-foreground">
              {t("repositories:credentialIssued")}{" "}
              {t("repositories:credentialReplaced")}
            </p>
          </div>
        ) : (
          error && <p className="text-sm font-medium text-destructive">{error}</p>
        )}

        <div>
          <Button onClick={issue} disabled={pending} variant="outline">
            {t("repositories:issueCredential")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
