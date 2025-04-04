"use client";

import { type ComponentProps, useState, useActionState } from "react";
import {
  addAccount,
  deleteAuthenticator,
  removeAccount,
  renameAuthenticator,
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
import { signIn } from "next-auth/webauthn";
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

export function Form({
  lang,
  ...props
}: ComponentProps<"form"> & { lang: string }) {
  const [, dispatch] = useActionState(addAccount, {});
  const { toast } = useToast();
  const [spinnerType, setSpinnerType] = useState<0 | 1 | 2>(0);
  const [registering, setRegistering] = useState(false);
  const { t } = useTranslation(lang);

  return (
    <form {...props} action={dispatch}>
      <div className="flex gap-4">
        <div>
          <SubmitButton
            variant="outline"
            disabled={registering}
            name="type"
            value="google"
            showSpinner={spinnerType === 0}
            onClick={() => setSpinnerType(0)}
          >
            <GoogleLogo />
          </SubmitButton>
        </div>

        <div>
          <SubmitButton
            variant="outline"
            disabled={registering}
            name="type"
            value="github"
            showSpinner={spinnerType === 1}
            onClick={() => setSpinnerType(1)}
          >
            <GitHubLogo />
          </SubmitButton>
        </div>

        <Separator orientation="vertical" className="h-auto my-1" />

        <div>
          <SubmitButton
            variant="outline"
            type="button"
            disabled={registering}
            showSpinner={false}
            onClick={async () => {
              setRegistering(true);
              try {
                await signIn("passkey", { action: "register" });
                toast({
                  title: t("success"),
                  description: t("account:security.passkeyRegistered"),
                });
              } catch {
                toast({
                  title: t("error"),
                  description: t("account:security.passkeyRegisterFailed"),
                  variant: "destructive",
                });
              } finally {
                setRegistering(false);
              }
            }}
          >
            {registering ? (
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            ) : (
              <KeyRound className="w-5 h-5 mr-2" />
            )}
            {t("account:security.passkey")}
          </SubmitButton>
        </div>
      </div>
    </form>
  );
}

function ListItem({
  account,
  lang,
}: {
  account: {
    provider: string;
    providerAccountId: string;
    emailOrUserName?: string;
  };
  lang: string;
}) {
  const [pending, setPending] = useState(false);
  const { toast } = useToast();
  const { t } = useTranslation(lang);

  return (
    <li className="flex items-center py-4 px-6 gap-2 border-b">
      <div className="border rounded-full p-2 mr-1">
        {account.provider === "google" ? (
          <GoogleLogo />
        ) : account.provider === "github" ? (
          <GitHubLogo />
        ) : (
          "unknown"
        )}
      </div>
      <div className="w-full">
        <div className="flex gap-2 items-center">
          <h4 className="font-bold text-lg">
            {account.provider === "google"
              ? "Google"
              : account.provider === "github"
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
                  data.append("provider", account.provider);
                  data.append("providerAccountId", account.providerAccountId);
                  const state = await removeAccount({}, data);
                  if (state.success) {
                    toast({
                      title: t("success"),
                      description: t("account:security.accountRemoved"),
                    });
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
    provider: string;
    providerAccountId: string;
    emailOrUserName?: string;
  }[];
  lang: string;
}) {
  return (
    <ul
      {...props}
      className={cn(props.className, "[&_li:last-child]:border-0")}
    >
      {accounts
        .filter((i) => i.provider !== "passkey")
        .map((account) => (
          <ListItem
            key={account.providerAccountId}
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
                    const { error } = await deleteAuthenticator({
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
                  await renameAuthenticator({ id: authenticator.id, name });
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
