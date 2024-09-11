import Link from "next/link";
import { StandardDrawer } from "./drawer";
import { NavigationMenu, NavigationMenuContent, NavigationMenuItem, NavigationMenuLink, NavigationMenuList, NavigationMenuTrigger, navigationMenuTriggerStyle, NavigationMenuViewport } from "./ui/navigation-menu";
import { CircleUser } from "lucide-react";
import { cn } from "@/lib/utils";

export default function NavBar() {
  return (
    <nav className="py-2 px-2 md:px-[52px] gap-2 flex sticky top-0 w-full items-center justify-between border-b bg-background z-10">
      <div className="gap-2 flex">
        <StandardDrawer />

        <Link className="decoration-0 flex gap-2 my-auto" href="/">
          <img className='align-bottom' src="/img/logo_dark.svg" alt="Logo" />
          <h1 className="font-semibold text-xl mt-1">Beutl</h1>
        </Link>
      </div>

      <div>
        <NavigationMenu>
          <NavigationMenuList>
            <Link href="/docs" legacyBehavior passHref className="max-md:hidden">
              <NavigationMenuLink className={navigationMenuTriggerStyle()}>
                ドキュメント
              </NavigationMenuLink>
            </Link>
            <Link href="/store" legacyBehavior passHref className="max-md:hidden">
              <NavigationMenuLink className={navigationMenuTriggerStyle()}>
                ストア
              </NavigationMenuLink>
            </Link>
            <Link href="/account" legacyBehavior passHref className="max-md:hidden">
              <NavigationMenuLink className={cn(navigationMenuTriggerStyle(), "px-2 w-10")}>
                <CircleUser className="w-5 h-5" />
              </NavigationMenuLink>
            </Link>
          </NavigationMenuList>
        </NavigationMenu>
      </div>
    </nav>
  )
}