"use client";

import { useActionState, useEffect, useRef } from "react";
import { useTranslation } from "@beutl/ui/i18n-client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@beutl/ui/ui/card";
import { ErrorDisplay } from "@beutl/ui/error-display";
import { Input } from "@beutl/ui/ui/input";
import { Label } from "@beutl/ui/ui/label";
import { Separator } from "@beutl/ui/ui/separator";
import SubmitButton from "@beutl/ui/submit-button";
import { KeyRound, Trash2 } from "lucide-react";
import { issueCredentialAction, revokeCredentialAction } from "./actions";
import type { CredentialResult } from "./actions";

export type CredentialSummary = {
  id: string;
  name: string;
  lastEight: string;
  createdAt: string;
};

export function CredentialsCard({
  lang,
  username,
  credentials,
  limit,
}: {
  lang: string;
  username: string;
  credentials: CredentialSummary[];
  limit: number;
}) {
  const { t } = useTranslation(lang);
  const formRef = useRef<HTMLFormElement>(null);
  const [issueState, issue] = useActionState(issueCredentialAction, {
    success: false,
  });
  const [revokeState, revoke] = useActionState(revokeCredentialAction, {
    success: false,
  });

  // 発行できたらラベル欄を空にする。次の端末をすぐ登録できるようにするため。
  useEffect(() => {
    if (issueState.success) formRef.current?.reset();
  }, [issueState.success]);

  const issued: CredentialResult | undefined = issueState.success
    ? issueState.data
    : undefined;
  const atLimit = credentials.length >= limit;

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

        {credentials.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">
              {t("repositories:issuedCredentials")}
            </span>
            <ul className="divide-y rounded-lg border">
              {credentials.map((credential) => (
                <li
                  key={credential.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm">{credential.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {t("repositories:credentialMeta", {
                        lastEight: credential.lastEight,
                        date: new Date(credential.createdAt).toLocaleDateString(
                          lang,
                        ),
                      })}
                    </span>
                  </div>
                  {/* 失効はこの 1 本だけに効く。他の端末は使い続けられる。 */}
                  <form action={revoke}>
                    <input
                      type="hidden"
                      name="credentialId"
                      value={credential.id}
                    />
                    <SubmitButton
                      variant="ghost"
                      size="sm"
                      aria-label={t("repositories:revoke")}
                    >
                      <Trash2 className="h-4 w-4" />
                    </SubmitButton>
                  </form>
                </li>
              ))}
            </ul>
            {!revokeState.success && revokeState.message && (
              <p className="text-sm font-medium text-destructive">
                {revokeState.message}
              </p>
            )}
          </div>
        )}

        {issued && (
          <div className="flex flex-col gap-2 rounded-lg border p-3">
            <Label htmlFor="git-token">
              {t("repositories:tokenFor", { name: issued.name })}
            </Label>
            {/* 平文はこの 1 回しか受け取れない。再読み込みすると消える。 */}
            <Input id="git-token" value={issued.token} readOnly />
            <p className="text-sm text-muted-foreground">
              {t("repositories:credentialIssued")}
            </p>
          </div>
        )}

        <Separator />

        <form ref={formRef} action={issue} className="flex flex-col gap-2">
          <Label htmlFor="label">{t("repositories:deviceLabel")}</Label>
          <div className="flex flex-wrap items-start gap-2">
            <Input
              id="label"
              name="label"
              autoComplete="off"
              className="max-w-xs"
              placeholder={t("repositories:deviceLabelPlaceholder")}
              disabled={atLimit}
            />
            <SubmitButton variant="outline" disabled={atLimit}>
              {t("repositories:issueCredential")}
            </SubmitButton>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("repositories:deviceLabelHint")}
          </p>
          {!issueState.success && issueState.errors?.label && (
            <ErrorDisplay errors={issueState.errors.label} />
          )}
          {!issueState.success && issueState.message && (
            <p className="text-sm font-medium text-destructive">
              {issueState.message}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
