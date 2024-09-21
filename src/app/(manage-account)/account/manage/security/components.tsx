"use client"

import { type ComponentProps, useEffect, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { addAccount, removeAccount } from "./actions";
import SubmitButton from "@/components/submit-button";
import { GitHubLogo, GoogleLogo } from "@/components/logo";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Loader2, Trash } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type FormProps = ComponentProps<"form"> & {
  accounts: {
    provider: string,
    emailOrUserName?: string
  }[],
}

export function Form({ accounts, ...props }: FormProps) {
  const [state, dispatch] = useFormState(addAccount, {});
  const [spinnerType, setSpinnerType] = useState<0 | 1>(0);

  return (
    <form {...props} action={dispatch}>
      <div className="flex gap-4">
        <div>
          <SubmitButton variant="outline" className="p-2 w-full"
            name="type" value="google" showSpinner={spinnerType === 0}
            onClick={() => setSpinnerType(0)}
          >
            <GoogleLogo />
          </SubmitButton>
        </div>

        <div>
          <SubmitButton variant="outline" className="p-2 w-full"
            name="type" value="github" showSpinner={spinnerType === 1}
            onClick={() => setSpinnerType(1)}
          >
            <GitHubLogo />
          </SubmitButton>
        </div>
      </div>
    </form>
  )
}

function DeleteButton(props: ButtonProps) {
  const { pending } = useFormStatus();

  return (
    <Button {...props} type="submit" disabled={pending}>
      {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash className="w-4 h-4 mr-2" />}
      {props.children}
    </Button>
  );
}

function ListItem({ account }: { account: { provider: string, providerAccountId: string, emailOrUserName?: string } }) {
  const [state, dispatch] = useFormState(removeAccount, {});
  const { toast } = useToast()

  useEffect(() => {
    if (!state.message) return;
    toast({
      title: state.message || undefined,
      variant: state.message ? "destructive" : "default",
    })
  }, [state, toast]);

  return (
    <TableRow>
      <TableCell className="font-medium py-2">
        {account.provider === "google" ? "Google"
          : account.provider === "github" ? "GitHub"
            : "unknown"}
      </TableCell>
      <TableCell className="py-2">{account.emailOrUserName}</TableCell>
      <TableCell className="text-right py-2">
        <form action={dispatch}>
          <input type="hidden" name="provider" value={account.provider} />
          <input type="hidden" name="providerAccountId" value={account.providerAccountId} />
          <DeleteButton size="sm" variant="outline">
            削除
          </DeleteButton>
        </form>
      </TableCell>
    </TableRow>
  )
}

export function List({ accounts, ...props }: ComponentProps<typeof Table> & {
  accounts: {
    provider: string,
    providerAccountId: string,
    emailOrUserName?: string
  }[],
}) {
  return (
    <Table {...props}>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[120px]">プロバイダ</TableHead>
          <TableHead>アカウント</TableHead>
          <TableHead className="text-right" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {accounts.map((account) => (
          <ListItem key={account.providerAccountId} account={account} />
        ))}
      </TableBody>
    </Table>
  )
}