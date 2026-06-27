import { getTranslation } from "@/app/i18n/server";
import { headers } from "next/headers";
import Image from "next/image";
import Link from "next/link";
import { navHref, socialLinks, type NavLinkKey } from "@/components/site-links";

export default async function Footer({ lang }: { lang: string }) {
  const url = new URL((await headers()).get("x-url") || "/");
  const langUrl = url.pathname?.replace(/\/ja/, "").replace(/\/en/, "");
  const { t } = await getTranslation(lang);

  return (
    <div className="bg-secondary">
      <div className="container mx-auto px-6 py-6 md:px-12">
        <div className="flex gap-8">
          {socialLinks.map((social) => (
            <Link key={social.label} href={social.href}>
              <Image
                width={24}
                height={24}
                alt={social.label}
                className="w-5 h-5 invert"
                src={social.iconSrc}
              />
            </Link>
          ))}
        </div>
        <div className="mt-8 flex gap-3 flex-wrap">
          {(["privacy", "telemetry", "docs"] as NavLinkKey[]).map((key) => (
            <Link key={key} href={navHref(key, lang)}>
              {t(key)}
            </Link>
          ))}
        </div>
        <div className="mt-4 flex justify-between">
          <div className="flex gap-3 flex-wrap">
            <Link href={`/ja${langUrl}`}>日本語</Link>
            <span>|</span>
            <Link href={`/en${langUrl}`}>English</Link>
          </div>
          <p className="text-end">© 2020-2025 b-editor</p>
        </div>
      </div>
    </div>
  );
}
