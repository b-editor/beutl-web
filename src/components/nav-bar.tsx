import Link from "next/link";
import { StandardDrawer } from "./drawer";
import {
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  navigationMenuTriggerStyle,
} from "./ui/navigation-menu";
import { CircleUser } from "lucide-react";
import { cn } from "@/lib/utils";
import { auth } from "@/auth";
import * as NavigationMenuPrimitive from "@radix-ui/react-navigation-menu";
import { getTranslation } from "@/app/i18n/server";

export default async function NavBar({ lang }: { lang: string }) {
  const { t } = await getTranslation(lang);
  const session = await auth();

  return (
    <nav className="py-2 px-2 md:px-[52px] gap-2 flex sticky top-0 w-full items-center justify-between border-b bg-background z-20">
      <div className="gap-2 flex">
        <StandardDrawer lang={lang} />

        <Link className="decoration-0 flex gap-2 my-auto" href={`/${lang}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="align-bottom"
            src="/img/logo_dark.svg"
            alt="Logo" />
          <h1 className="font-semibold text-xl mt-1">Beutl</h1>
        </Link>
      </div>

      <div>
        <NavigationMenuPrimitive.Root
          className={cn(
            "relative z-10 flex max-w-max flex-1 items-center justify-center",
          )}
        >
          <NavigationMenuList>
            <Link
              href={`https://docs.beutl.beditor.net/${lang}`}
              prefetch={false}
              legacyBehavior
              passHref
            >
              <NavigationMenuLink
                className={cn(navigationMenuTriggerStyle(), "max-md:hidden")}
              >
                {t("docs")}
              </NavigationMenuLink>
            </Link>
            <Link
              href={`/${lang}/store`}
              legacyBehavior
              passHref
              className="max-sm:hidden"
            >
              <NavigationMenuLink
                className={cn(navigationMenuTriggerStyle(), "max-md:hidden")}
              >
                {t("store")}
              </NavigationMenuLink>
            </Link>
            {session?.user ? (
              <NavigationMenuItem>
                <NavigationMenuPrimitive.Trigger
                  className={cn(navigationMenuTriggerStyle(), "group")}
                >
                  <CircleUser className="w-5 h-5" />
                </NavigationMenuPrimitive.Trigger>
                <NavigationMenuContent>
                  <ul className="flex flex-col gap-3 p-2 w-auto">
                    <li>
                      <NavigationMenuLink asChild>
                        <Link
                          href={`/${lang}/account`}
                          className="block whitespace-nowrap select-none space-y-1 rounded-md p-3 leading-none no-underline outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
                        >
                          {t("account")}
                        </Link>
                      </NavigationMenuLink>
                      <NavigationMenuLink asChild>
                        <Link
                          href={`/${lang}/storage`}
                          className="block whitespace-nowrap select-none space-y-1 rounded-md p-3 leading-none no-underline outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
                        >
                          {t("storage")}
                        </Link>
                      </NavigationMenuLink>
                      <NavigationMenuLink asChild>
                        <Link
                          href={`/${lang}/developer`}
                          className="block whitespace-nowrap select-none space-y-1 rounded-md p-3 leading-none no-underline outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
                        >
                          {t("developer")}
                        </Link>
                      </NavigationMenuLink>
                      <NavigationMenuLink asChild>
                        <Link
                          href={`/${lang}/library`}
                          className="block whitespace-nowrap select-none space-y-1 rounded-md p-3 leading-none no-underline outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
                        >
                          {t("library")}
                        </Link>
                      </NavigationMenuLink>
                    </li>
                  </ul>
                </NavigationMenuContent>
              </NavigationMenuItem>
            ) : (
              <Link href={`/${lang}/account`} legacyBehavior passHref>
                <NavigationMenuLink
                  className={cn(navigationMenuTriggerStyle(), "px-2 w-10")}
                >
                  <CircleUser className="w-5 h-5" />
                </NavigationMenuLink>
              </Link>
            )}
          </NavigationMenuList>

          <div className={cn("absolute right-0 top-full flex justify-center")}>
            <NavigationMenuPrimitive.Viewport
              className={cn(
                "origin-top-center relative mt-1.5 h-[var(--radix-navigation-menu-viewport-height)] w-full overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-90 md:w-[var(--radix-navigation-menu-viewport-width)]",
              )}
            />
          </div>
        </NavigationMenuPrimitive.Root>
      </div>
    </nav>
  );
}
