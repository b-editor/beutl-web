"use client";

import { type ComponentProps, useState } from "react";
import {
  deletePasskey,
  removeAccount,
  renamePasskey,
} from "./actions";
import SubmitButton from "@/components/submit-button";
import { GitHubLogo, GoogleLogo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import {
  Edit,
  KeyRound,
  Loader2,
  MoreVertical,
  Save,
  Trash,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { getRelativeTimeDifference } from "@/lib/relative-time";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTranslation } from "@/app/i18n/client";
import { useRouter } from "next/navigation";

export function Form({
  lang,
  ...props
}: ComponentProps<"div"> & { lang: string }) {
  const { toast } = useToast();
  const [loading, setLoading] = useState<string | null>(null);
  const { t } = useTranslation(lang);
  const router = useRouter();

  const handleOAuthLink = async (provider: "google" | "github") => {
    setLoading(provider);
    try {
      await authClient.linkSocial({
        provider,
        callbackURL: `/${lang}/account/manage/security`,
      });
    } catch {
      toast({
        title: t("error"),
        description: t("auth:errors.oauth"),
        variant: "destructive",
      });
      setLoading(null);
    }
  };

  const handlePasskeyRegister = async () => {
    setLoading("passkey");
    try {
      const result = await authClient.passkey.addPasskey();
      if (result?.error) {
        throw new Error(result.error.message);
      }
      toast({
        title: t("success"),
        description: t("account:security.passkeyRegistered"),
      });
      router.refresh();
    } catch {
      toast({
        title: t("error"),
        description: t("account:security.passkeyRegisterFailed"),
        variant: "destructive",
      });
    } finally {
      setLoading(null);
    }
  };

  return (
    <div {...props}>
      <div className="flex gap-4">
        <div>
          <SubmitButton
            variant="outline"
            type="button"
            disabled={loading !== null}
            showSpinner={false}
            forceSpinner={loading === "google"}
            onClick={() => handleOAuthLink("google")}
          >
            <GoogleLogo />
          </SubmitButton>
        </div>

        <div>
          <SubmitButton
            variant="outline"
            type="button"
            disabled={loading !== null}
            showSpinner={false}
            forceSpinner={loading === "github"}
            onClick={() => handleOAuthLink("github")}
          >
            <GitHubLogo />
          </SubmitButton>
        </div>

        <Separator orientation="vertical" className="h-auto my-1" />

        <div>
          <SubmitButton
            variant="outline"
            type="button"
            disabled={loading !== null}
            showSpinner={false}
            forceSpinner={loading === "passkey"}
            onClick={handlePasskeyRegister}
          >
            {loading === "passkey" ? (
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            ) : (
              <KeyRound className="w-5 h-5 mr-2" />
            )}
            {t("account:security.passkey")}
          </SubmitButton>
        </div>
      </div>
    </div>
  );
}

function ListItem({
  account,
  lang,
}: {
  account: {
    providerId: string;
    accountId: string;
    emailOrUserName?: string;
  };
  lang: string;
}) {
  const [pending, setPending] = useState(false);
  const { toast } = useToast();
  const { t } = useTranslation(lang);
  const router = useRouter();

  return (
    <li className="flex items-center py-4 px-6 gap-2 border-b">
      <div className="border rounded-full p-2 mr-1">
        {account.providerId === "google" ? (
          <GoogleLogo />
        ) : account.providerId === "github" ? (
          <GitHubLogo />
        ) : (
          "unknown"
        )}
      </div>
      <div className="w-full">
        <div className="flex gap-2 items-center">
          <h4 className="font-bold text-lg">
            {account.providerId === "google"
              ? "Google"
              : account.providerId === "github"
                ? "GitHub"
                : "unknown"}
          </h4>
        </div>
        {account.emailOrUserName && (
          <p className="text-sm text-muted">{account.emailOrUserName}</p>
        )}
      </div>

      <div className="flex gap-2 justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon">
              {pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <MoreVertical className="w-4 h-4" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem
              disabled={pending}
              onClick={async () => {
                setPending(true);
                try {
                  const data = new FormData();
                  data.append("providerId", account.providerId);
                  data.append("accountId", account.accountId);
                  const state = await removeAccount({}, data);
                  if (state.success) {
                    toast({
                      title: t("success"),
                      description: t("account:security.accountRemoved"),
                    });
                    router.refresh();
                  } else {
                    toast({
                      title: t("error"),
                      description: state.message,
                      variant: "destructive",
                    });
                  }
                } catch (e) {
                  if (e instanceof Error) {
                    toast({
                      title: t("error"),
                      description: e.message,
                      variant: "destructive",
                    });
                  }
                } finally {
                  setPending(false);
                }
              }}
            >
              {pending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash className="w-4 h-4 mr-2" />
              )}
              {t("remove")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

export function List({
  accounts,
  lang,
  ...props
}: ComponentProps<"ul"> & {
  accounts: {
    providerId: string;
    accountId: string;
    emailOrUserName?: string;
  }[];
  lang: string;
}) {
  return (
    <ul
      {...props}
      className={cn(props.className, "[&_li:last-child]:border-0")}
    >
      {accounts.map((account) => (
        <ListItem
          key={account.accountId}
          account={account}
          lang={lang}
        />
      ))}
    </ul>
  );
}

function PasskeyListItem({
  authenticator,
  lang,
  ...props
}: ComponentProps<"li"> & {
  authenticator: {
    id: string;
    deviceType: "singleDevice" | "multiDevice";
    backedUp: boolean;
    name: string;
    createdAt: Date;
    usedAt: Date;
  };
  lang: string;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(authenticator.name ?? "Unnamed");
  const [pending, setPending] = useState(false);
  const { toast } = useToast();
  const { t } = useTranslation(lang);

  return (
    <li {...props} className="flex items-center py-4 px-6 gap-2 border-b">
      <div className="border rounded-full p-2 mr-1">
        <KeyRound />
      </div>
      <div className="w-full">
        {!editing && (
          <>
            <div className="flex gap-2 items-center">
              <h4 className="font-bold text-lg">{name}</h4>
              {authenticator.deviceType === "multiDevice" && (
                <Badge variant={authenticator.backedUp ? "default" : "outline"}>
                  {authenticator.backedUp
                    ? t("account:security.syncStatus.synced")
                    : t("account:security.syncStatus.syncable")}
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted">
              {t("account:security.createdAt")}:{" "}
              {getRelativeTimeDifference(authenticator.createdAt)}{" "}
              {authenticator.usedAt && (
                <>
                  {" "}
                  | {t("account:security.usedAt")}:{" "}
                  {getRelativeTimeDifference(authenticator.usedAt)}
                </>
              )}
            </p>
          </>
        )}
        {editing && (
          <Input
            name="name"
            autoComplete="off"
            placeholder={t("account:security.name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </div>

      <div className="flex gap-2 justify-end">
        {!editing && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon">
                {pending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <MoreVertical className="w-4 h-4" />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem
                onClick={() => setEditing(true)}
                disabled={pending}
              >
                <Edit className="w-4 h-4 mr-2" />
                {t("edit")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={pending}
                onClick={async () => {
                  setPending(true);
                  try {
                    const { error } = await deletePasskey({
                      id: authenticator.id,
                    });
                    if (error) {
                      toast({
                        title: t("error"),
                        description: error,
                        variant: "destructive",
                      });
                    }
                  } finally {
                    setPending(false);
                  }
                }}
              >
                {pending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Trash className="w-4 h-4 mr-2" />
                )}
                {t("remove")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {editing && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={async () => {
                try {
                  setPending(true);
                  await renamePasskey({ id: authenticator.id, name });
                  setEditing(false);
                } finally {
                  setPending(false);
                }
              }}
            >
              {pending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              {t("save")}
            </Button>

            <Button
              size="sm"
              variant="outline"
              type="reset"
              disabled={pending}
              onClick={() => {
                setName(authenticator.name ?? "Unnamed");
                setEditing(false);
              }}
            >
              {t("cancel")}
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

export function PasskeysList({
  authenticators,
  lang,
  ...props
}: ComponentProps<"ul"> & {
  authenticators: {
    id: string;
    deviceType: "singleDevice" | "multiDevice";
    backedUp: boolean;
    name: string;
    createdAt: Date;
    usedAt: Date;
  }[];
  lang: string;
}) {
  return (
    <ul
      {...props}
      className={cn(props.className, "[&_li:last-child]:border-0")}
    >
      {authenticators.map((auth) => (
        <PasskeyListItem key={auth.id} authenticator={auth} lang={lang} />
      ))}
    </ul>
  );
}
