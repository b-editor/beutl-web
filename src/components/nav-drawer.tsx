import { Menu } from "lucide-react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./ui/sheet";
import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  navigationMenuTriggerStyle,
} from "./ui/navigation-menu";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { getTranslation } from "@/app/i18n/server";
import { navHref, socialLinks, type NavLinkKey } from "@/components/site-links";

export async function StandardDrawer({ lang }: { lang: string }) {
  const { t } = await getTranslation(lang);
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          className="w-9 h-9 md:hidden"
          variant="ghost"
          size="icon"
          aria-label={t("openMenu")}
        >
          <Menu className="h-4 w-4" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left">
        <div className="h-full flex flex-col justify-between">
          <div>
            <SheetHeader>
              <SheetTitle className="flex gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  className="align-bottom ml-2"
                  src="/img/logo_dark.svg"
                  alt="Logo"
                />
                <span className="font-semibold text-xl mt-1">Beutl</span>
              </SheetTitle>
            </SheetHeader>

            <NavigationMenu className="flex-col items-stretch max-w-full pt-4">
              <NavigationMenuList className="flex-col items-stretch space-x-0">
                {(["docs", "store", "privacy", "telemetry"] as NavLinkKey[]).map(
                  (key) => (
                    <NavigationMenuItem key={key}>
                      <NavigationMenuLink
                        className={cn(
                          navigationMenuTriggerStyle(),
                          "w-full justify-start",
                        )}
                        asChild
                      >
                        <Link
                          href={navHref(key, lang)}
                          prefetch={key === "docs" ? false : undefined}
                        >
                          {t(key)}
                        </Link>
                      </NavigationMenuLink>
                    </NavigationMenuItem>
                  ),
                )}
              </NavigationMenuList>
            </NavigationMenu>
          </div>

          <div>
            <h3>{t("socials")}</h3>
            <NavigationMenu className="flex-col items-stretch max-w-full">
              <NavigationMenuList className="flex-col items-stretch space-x-0">
                {socialLinks.map((social) => (
                  <NavigationMenuItem key={social.label}>
                    <NavigationMenuLink
                      className={cn(
                        navigationMenuTriggerStyle(),
                        "w-full justify-start",
                      )}
                      asChild
                    >
                      <Link href={social.href}>
                        <Image
                          width={24}
                          height={24}
                          alt={social.label}
                          className="w-5 h-5 invert mr-2"
                          src={social.iconSrc}
                        />
                        {social.label}
                      </Link>
                    </NavigationMenuLink>
                  </NavigationMenuItem>
                ))}
              </NavigationMenuList>
            </NavigationMenu>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
