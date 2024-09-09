import Link from "next/link";
import { StandardDrawer } from "./drawer";
import { NavigationMenu, NavigationMenuContent, NavigationMenuItem, NavigationMenuLink, NavigationMenuList, NavigationMenuTrigger } from "./ui/navigation-menu";

export default function NavBar() {
  return (
    <nav className="py-2 px-2 md:px-[52px] gap-2 flex sticky top-0 w-full items-center justify-between border-b bg-background">
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
            <NavigationMenuItem>
              <NavigationMenuTrigger>Item One</NavigationMenuTrigger>
              <NavigationMenuContent>
                <NavigationMenuLink>Link</NavigationMenuLink>
              </NavigationMenuContent>
            </NavigationMenuItem>
          </NavigationMenuList>
        </NavigationMenu>
      </div>
    </nav>
  )
}