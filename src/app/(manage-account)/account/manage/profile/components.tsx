"use client"

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Prisma, PrismaClient } from "@prisma/client";
import { Lock, LockOpen } from "lucide-react";
import { useState } from "react";

export function ChangeUserName({ profile }: { profile: Prisma.Result<PrismaClient["profile"], unknown, "findFirst"> }) {
  const [locked, setLocked] = useState(true);

  return (
    <div className="flex flex-col space-y-1.5 max-w-xs">
      <Label htmlFor="userName">ユーザーID</Label>
      <div className="flex gap-2">
        <Input type="text" id="userName" name="userName" defaultValue={profile?.userName} disabled={locked} />

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" className={locked ? "" : "pointer-events-none select-none"}>
              {locked ? <Lock className="w-4 h-4" /> : <LockOpen className="w-4 h-4" />}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>ユーザーIDを変更しますか？</AlertDialogTitle>
              <AlertDialogDescription className="text-foreground">
                <p>ユーザー識別に使う一意なIDを変更できます。</p>
                <p>以下の点をご確認ください。</p>
                <ul className="list-disc list-inside ml-4 mt-2">
                  <li>変更後、元のIDに戻すことができなくなる可能性があります。</li>
                  <li>変更後、他のユーザーが元のIDを使う可能性があります。</li>
                  <li>元のIDを使用して、あなたのプロフィールにアクセスできなくなります。</li>
                </ul>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>キャンセル</AlertDialogCancel>
              <AlertDialogAction onClick={() => setLocked(false)}>続ける</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      <p className="text-sm text-muted-foreground">ユーザー識別に使う一意なIDを変更できます。 変更するとブックマークされているURLなどが使えなくなる可能性があります。</p>
    </div>
  )
}