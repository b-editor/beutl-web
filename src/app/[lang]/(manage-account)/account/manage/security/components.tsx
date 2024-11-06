"use client"

import { type ComponentProps, useState } from "react";
import { useFormState } from "react-dom";
import { addAccount, deleteAuthenticator, removeAccount, renameAuthenticator } from "./actions";
import SubmitButton from "@/components/submit-button";
import { GitHubLogo, GoogleLogo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Edit, KeyRound, Loader2, MoreVertical, Save, Trash } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { signIn } from "next-auth/webauthn"
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { getRelativeTimeDifference } from "@/lib/relative-time";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export function Form({ ...props }: ComponentProps<"form">) {
  const [state, dispatch] = useFormState(addAccount, {});
  const { toast } = useToast();
  const [spinnerType, setSpinnerType] = useState<0 | 1 | 2>(0);
  const [registering, setRegistering] = useState(false);

  return (
    <form {...props} action={dispatch}>
      <div className="flex gap-4">
        <div>
          <SubmitButton variant="outline" disabled={registering}
            name="type" value="google" showSpinner={spinnerType === 0}
            onClick={() => setSpinnerType(0)}
          >
            <GoogleLogo />
          </SubmitButton>
        </div>

        <div>
          <SubmitButton variant="outline" disabled={registering}
            name="type" value="github" showSpinner={spinnerType === 1}
            onClick={() => setSpinnerType(1)}
          >
            <GitHubLogo />
          </SubmitButton>
        </div>

        <Separator orientation="vertical" className="h-auto my-1" />

        <div>
          <SubmitButton variant="outline" type="button" disabled={registering}
            showSpinner={false}
            onClick={async () => {
              setRegistering(true);
              try {
                await signIn("passkey", { action: "register" });
                toast({
                  title: "成功",
                  description: "パスキーを登録しました"
                });
              } catch {
                toast({
                  title: "エラー",
                  description: "パスキーを登録できませんでした",
                  variant: "destructive",
                });
              } finally {
                setRegistering(false);
              }
            }}
          >
            {registering ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <KeyRound className="w-5 h-5 mr-2" />}
            パスキー
          </SubmitButton>
        </div>
      </div>
    </form>
  )
}

function ListItem({ account }: { account: { provider: string, providerAccountId: string, emailOrUserName?: string } }) {
  const [pending, setPending] = useState(false);
  const { toast } = useToast();

  return (
    <li className="flex items-center py-4 px-6 gap-2 border-b">
      <div className="border rounded-full p-2 mr-1">
        {account.provider === "google" ? <GoogleLogo />
          : account.provider === "github" ? <GitHubLogo />
            : "unknown"}
      </div>
      <div className="w-full">
        <div className="flex gap-2 items-center">
          <h4 className="font-bold text-lg">
            {account.provider === "google" ? "Google"
              : account.provider === "github" ? "GitHub"
                : "unknown"}
          </h4>
        </div>
        {account.emailOrUserName && (
          <p className="text-sm text-muted">
            {account.emailOrUserName}
          </p>
        )}
      </div>

      <div className="flex gap-2 justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon">
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreVertical className="w-4 h-4" />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem disabled={pending} onClick={async () => {
              setPending(true);
              try {
                const data = new FormData();
                data.append("provider", account.provider);
                data.append("providerAccountId", account.providerAccountId);
                const state = await removeAccount({}, data);
                if (state.success) {
                  toast({
                    title: "成功",
                    description: "アカウントを削除しました"
                  });
                } else {
                  toast({
                    title: "エラー",
                    description: state.message,
                    variant: "destructive",
                  });
                }
              } catch (e) {
                if (e instanceof Error) {
                  toast({
                    title: "エラー",
                    description: e.message,
                    variant: "destructive",
                  });
                }
              } finally {
                setPending(false);
              }
            }}>
              {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash className="w-4 h-4 mr-2" />}
              削除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  )
}

export function List({ accounts, ...props }: ComponentProps<"ul"> & {
  accounts: {
    provider: string,
    providerAccountId: string,
    emailOrUserName?: string
  }[],
}) {
  return (
    <ul {...props} className={cn(props.className, "[&_li:last-child]:border-0")}>
      {accounts.filter(i => i.provider !== "passkey").map((account) => (
        <ListItem key={account.providerAccountId} account={account} />
      ))}
    </ul>
  )
}

function PasskeyListItem({ authenticator, ...props }: ComponentProps<"li"> & {
  authenticator: {
    id: string,
    deviceType: "singleDevice" | "multiDevice",
    backedUp: boolean,
    name: string,
    createdAt: Date,
    usedAt: Date,
  },
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(authenticator.name ?? "Unnamed");
  const [pending, setPending] = useState(false);
  const { toast } = useToast();

  return (
    <li {...props} className="flex items-center py-4 px-6 gap-2 border-b">
      <div className="border rounded-full p-2 mr-1">
        <KeyRound />
      </div>
      <div className="w-full">
        {!editing && <>
          <div className="flex gap-2 items-center">
            <h4 className="font-bold text-lg">{name}</h4>
            {authenticator.deviceType === "multiDevice" && (
              <Badge variant={authenticator.backedUp ? "default" : "outline"}>
                {authenticator.backedUp ? "同期されています" : "同期可能です"}
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted">
            {getRelativeTimeDifference(authenticator.createdAt)} に作成 {authenticator.usedAt && <> | {getRelativeTimeDifference(authenticator.usedAt)} に使用</>}
          </p>
        </>}
        {editing &&
          <Input name="name" autoComplete="off" placeholder="名前" value={name} onChange={(e) => setName(e.target.value)} />
        }
      </div>

      <div className="flex gap-2 justify-end">
        {!editing &&
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon">
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreVertical className="w-4 h-4" />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => setEditing(true)} disabled={pending}>
                <Edit className="w-4 h-4 mr-2" />
                編集
              </DropdownMenuItem>
              <DropdownMenuItem disabled={pending} onClick={async () => {
                setPending(true);
                try {
                  await deleteAuthenticator({ id: authenticator.id })
                } catch (e) {
                  if (e instanceof Error) {
                    toast({
                      title: "エラー",
                      description: e.message,
                      variant: "destructive",
                    });
                  }
                } finally {
                  setPending(false);
                }
              }}>
                {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash className="w-4 h-4 mr-2" />}
                削除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
        {editing && <>
          <Button size="sm" variant="outline"
            disabled={pending}
            onClick={async () => {
              try {
                setPending(true);
                await renameAuthenticator({ id: authenticator.id, name });
                setEditing(false);
              } finally {
                setPending(false);
              }
            }}>
            {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
            保存
          </Button>

          <Button size="sm" variant="outline" type="reset"
            disabled={pending}
            onClick={() => {
              setName(authenticator.name ?? "Unnamed");
              setEditing(false);
            }}>
            キャンセル
          </Button>
        </>}

      </div>
    </li>
  )
}

export function PasskeysList({ authenticators, ...props }: ComponentProps<"ul"> & {
  authenticators: {
    id: string,
    deviceType: "singleDevice" | "multiDevice",
    backedUp: boolean,
    name: string,
    createdAt: Date,
    usedAt: Date,
  }[],
}) {
  return (
    <ul {...props} className={cn(props.className, "[&_li:last-child]:border-0")}>
      {authenticators.map((auth) => (
        <PasskeyListItem key={auth.id} authenticator={auth} />
      ))}
    </ul>
  )
}