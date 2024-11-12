"use client"

import { useTranslation } from "@/app/i18n/client";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { CircleUser, Mail, Shield, Trash } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";

export function Navigation({ lang }: { lang: string }) {
  const { t } = useTranslation(lang);
  const pathname = usePathname();
  const slug = useMemo(() => pathname.split("/")[3], [pathname]);

  return (
    <ToggleGroup type="single" className="flex-col items-stretch w-full md:min-w-72"
      value={slug}>
      <Link href={`/${lang}/account/manage/profile`} passHref className="contents">
        <ToggleGroupItem value="profile" aria-label="Profile" className="justify-start">
          <CircleUser className="w-4 h-4 mr-2" />
          {t("account:profile.title")}
        </ToggleGroupItem>
      </Link>
      <Link href={`/${lang}/account/manage/email`} passHref className="contents">
        <ToggleGroupItem value="email" aria-label="Email Address" className="justify-start">
          <Mail className="w-4 h-4 mr-2" />
          {t("account:email.title")}
        </ToggleGroupItem>
      </Link>
      <Link href={`/${lang}/account/manage/security`} passHref className="contents">
        <ToggleGroupItem value="security" aria-label="Security Settings" className="justify-start">
          <Shield className="w-4 h-4 mr-2" />
          {t("account:security.title")}
        </ToggleGroupItem>
      </Link>
      <Link href={`/${lang}/account/manage/personal-data`} passHref className="contents">
        <ToggleGroupItem value="personal-data" aria-label="Personal Data" className="justify-start">
          <Trash className="w-4 h-4 mr-2" />
          {t("account:data.title")}
        </ToggleGroupItem>
      </Link>
    </ToggleGroup>
  )
}