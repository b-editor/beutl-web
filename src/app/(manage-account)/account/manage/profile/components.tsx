"use client"

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Prisma, PrismaClient } from "@prisma/client";

export function ChangeUserName({ profile }: { profile: Prisma.Result<PrismaClient["profile"], unknown, "findFirst"> }) {
  return (
    <div className="flex flex-col space-y-1.5 max-w-xs">
      <Label htmlFor="userName">ユーザーID</Label>
      <Input type="text" id="userName" name="userName" defaultValue={profile?.userName} />
    </div>
  )
}