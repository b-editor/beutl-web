"use client"

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { CircleUser, Mail, Shield, Trash } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";

export function Navigation() {
  const pathname = usePathname();
  const slug = useMemo(() => pathname.split("/")[3], [pathname]);

  return (
    <ToggleGroup type="single" className="flex-col items-stretch w-full md:min-w-72"
      value={slug}>
      <Link href="/account/manage/profile" passHref className="contents">
        <ToggleGroupItem value="profile" aria-label="Toggle bold" className="justify-start">
          <CircleUser className="w-4 h-4 mr-2" />
          プロフィール
        </ToggleGroupItem>
      </Link>
      <Link href="/account/manage/email" passHref className="contents">
        <ToggleGroupItem value="email" aria-label="Toggle bold" className="justify-start">
          <Mail className="w-4 h-4 mr-2" />
          メールアドレス
        </ToggleGroupItem>
      </Link>
      <Link href="/account/manage/security" passHref className="contents">
        <ToggleGroupItem value="security" aria-label="Toggle bold" className="justify-start">
          <Shield className="w-4 h-4 mr-2" />
          セキュリティ
        </ToggleGroupItem>
      </Link>
      <Link href="/account/manage/personal-data" passHref className="contents">
        <ToggleGroupItem value="personal-data" aria-label="Toggle bold" className="justify-start">
          <Trash className="w-4 h-4 mr-2" />
          個人情報
        </ToggleGroupItem>
      </Link>
    </ToggleGroup>
  )
}