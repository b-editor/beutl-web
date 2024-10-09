import { Menu } from "lucide-react"
import Image from "next/image";
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from './ui/sheet';
import { NavigationMenu, NavigationMenuLink, NavigationMenuList, navigationMenuTriggerStyle } from './ui/navigation-menu';
import Link from 'next/link';
import { cn } from '@/lib/utils';

export function StandardDrawer() {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button className='w-9 h-9 md:hidden' variant="ghost" size="icon">
          <Menu className="h-4 w-4" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left">
        <div className='h-full flex flex-col justify-between'>
          <div>
            <SheetHeader>
              <SheetTitle className='flex gap-2'>
                <img className='align-bottom ml-2' src="/img/logo_dark.svg" alt="Logo" />
                <p className='font-semibold text-xl mt-1'>Beutl</p>
              </SheetTitle>
            </SheetHeader>

            <NavigationMenu className='flex-col items-stretch max-w-full pt-4'>
              <NavigationMenuList className='flex-col items-stretch space-x-0'>
                <NavigationMenuLink className={cn(navigationMenuTriggerStyle(), "w-full justify-start")} asChild>
                  <Link href="/docs">
                    ドキュメント
                  </Link>
                </NavigationMenuLink>
                <NavigationMenuLink className={cn(navigationMenuTriggerStyle(), "w-full justify-start")} asChild>
                  <Link href="/store">
                    ストア
                  </Link>
                </NavigationMenuLink>
                <NavigationMenuLink className={cn(navigationMenuTriggerStyle(), "w-full justify-start")} asChild>
                  <Link href="/docs/privacy">
                    プライバシーポリシー
                  </Link>
                </NavigationMenuLink>
                <NavigationMenuLink className={cn(navigationMenuTriggerStyle(), "w-full justify-start")} asChild>
                  <Link href="/docs/telemetry">
                    テレメトリーポリシー
                  </Link>
                </NavigationMenuLink>
              </NavigationMenuList>
            </NavigationMenu>
          </div>

          <div>

            <h3>ソーシャル</h3>
            <NavigationMenu className='flex-col items-stretch max-w-full'>
              <NavigationMenuList className='flex-col items-stretch space-x-0'>
                <NavigationMenuLink className={cn(navigationMenuTriggerStyle(), "w-full justify-start")} asChild>
                  <Link href="https://github.com/b-editor">
                    <Image width={24} height={24} alt="GitHub" className="w-5 h-5 invert mr-2" src="/img/github-color.svg" />
                    GitHub
                  </Link>
                </NavigationMenuLink>
                <NavigationMenuLink className={cn(navigationMenuTriggerStyle(), "w-full justify-start")} asChild>
                  <Link href="https://x.com/yuto_daisensei">
                    <Image width={24} height={24} alt="GitHub" className="w-5 h-5 invert mr-2" src="/img/x.svg" />
                    X
                  </Link>
                </NavigationMenuLink>
                <NavigationMenuLink className={cn(navigationMenuTriggerStyle(), "w-full justify-start")} asChild>
                  <Link href="https://discord.gg/Bm3pnVc928">
                    <Image width={24} height={24} alt="GitHub" className="w-5 h-5 invert mr-2" src="/img/discord.svg" />
                    Discord
                  </Link>
                </NavigationMenuLink>
              </NavigationMenuList>
            </NavigationMenu>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
