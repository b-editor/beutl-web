"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from "@/components/ui/carousel";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { MoreVertical } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { addToLibrary, removeFromLibrary } from "./actions";
import { useMatchMedia } from "@/hooks/use-match-media";
import { Package } from "@/lib/store-utils";
import { formatAmount } from "@/lib/currency-formatter";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";

type Price = {
  price: number;
  currency: string;
}

type PageProps = {
  pkg: Package;
  owned: boolean;
  paied: boolean;
  message?: "PleaseOpenDesktopApp";
  price?: Price;
  lang: string;
}

type GetButtonProps = {
  pkgId: string;
  owned: boolean;
  price?: Price;
  paied: boolean;
  lang: string;
}

function GetButton({ pkgId, owned, price, paied, lang }: GetButtonProps) {
  return (
    <Button disabled={owned} onClick={() => addToLibrary(pkgId)}>
      {owned ? "入手済"
        : paied ? "入手 (購入済)"
          : price ? formatAmount(price.price, price.currency, lang)
            : "入手"}
    </Button>
  )
}

function RemoveFromLibraryDialog({
  pkgId, open, onClose, price, paied, lang
}: {
  pkgId: string,
  open: boolean,
  onClose: () => void
  price?: Price,
  paied: boolean,
  lang: string
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={onClose}
    >
      <AlertDialogContent className="sm:max-w-[425px]">
        <AlertDialogHeader>
          <AlertDialogTitle>ライブラリから削除しますか？</AlertDialogTitle>
        </AlertDialogHeader>
        <div>
          <p>ライブラリから削除すると、再度入手するまで利用できなくなります。</p>
          {(!paied && price) && (
            <p>再度入手するには、{formatAmount(price.price, price.currency, lang)}かかります。</p>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>キャンセル</AlertDialogCancel>
          <AlertDialogAction onClick={async () => await removeFromLibrary(pkgId)}>削除</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function ClientPage({
  pkg, owned, message, price, paied, lang
}: PageProps) {
  const defaultVersion = useMemo(() => pkg.Release.length > 0 ? pkg.Release[0].version : undefined, [pkg.Release]);
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedVersion = useMemo(() => searchParams.get("v") || defaultVersion, [searchParams, defaultVersion]);
  const selectedRelease = useMemo(() => {
    if (selectedVersion) {
      return pkg.Release.find(v => v.version === selectedVersion);
    }
  }, [selectedVersion, pkg.Release]);
  const maxLg = useMatchMedia("(min-width: 1024px)", false);
  const [open, setOpen] = useState(false);

  return (
    <div className="max-w-5xl mx-auto py-10 lg:py-6 px-4 lg:px-6 bg-card lg:rounded-lg border text-card-foreground lg:my-4">
      <div className="max-sm:relative sm:flex sm:gap-2">
        <div className="w-full flex justify-between gap-4 max-sm:flex-col">
          <div className="flex gap-4">
            {pkg.iconFileUrl && <Image width={64} height={64}
              className="w-16 h-16 max-w-fit rounded-md"
              alt="Package icon" src={pkg.iconFileUrl} />}
            {!pkg.iconFileUrl && <div className="w-16 h-16 rounded-md bg-secondary" />}
            <div>
              <h2 className="font-bold text-2xl">{pkg.displayName || pkg.name}</h2>
              <Button asChild variant="link" className="p-0 h-auto text-muted-foreground">
                <Link href={`/${lang}/publishers/${pkg.user.Profile?.userName}`}>{pkg.user.Profile?.userName}</Link>
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:items-end">
            <GetButton
              pkgId={pkg.id}
              owned={owned}
              price={price}
              paied={paied}
              lang={lang}
            />
            {message && <p>インストールするにはデスクトップアプリを開いてください</p>}
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="max-sm:absolute max-sm:right-0 top-0">
              <MoreVertical className="w-4 h-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {owned && (
              <DropdownMenuItem onClick={() => setOpen(true)}>
                ライブラリから削除
              </DropdownMenuItem>
            )}
            <DropdownMenuLabel>バージョン</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={selectedRelease?.version}
              onValueChange={(v) => {
                const url = new URL(location.href);
                if (v === defaultVersion) {
                  url.searchParams.delete("v");
                } else {
                  url.searchParams.set("v", v);
                }

                router.push(url.toString());
              }}>
              {pkg.Release.map((release) => (
                <DropdownMenuRadioItem value={release.version} key={release.id}>
                  {release.version}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {/* <DropdownMenuSeparator />
            <DropdownMenuItem>コンテンツを報告</DropdownMenuItem> */}
          </DropdownMenuContent>
        </DropdownMenu>
        <RemoveFromLibraryDialog
          pkgId={pkg.id}
          open={open}
          onClose={() => setOpen(false)}
          price={price}
          paied={paied}
          lang={lang}
        />
      </div>
      <p className="mt-4 text-foreground/70">{pkg.shortDescription}</p>

      {pkg.PackageScreenshot && pkg.PackageScreenshot.length > 0 && (
        <>
          <h3 className="font-bold text-xl mt-6 border-b pb-2">スクリーンショット</h3>
          <Carousel className="mt-4" opts={{ active: maxLg }}>
            <CarouselContent className="max-lg:overflow-x-scroll max-lg:hidden-scrollbar">
              {pkg.PackageScreenshot.map((item) => (
                <CarouselItem className="w-min max-w-min min-w-min" key={item.file.id}>
                  <Image className="rounded max-w-min h-80 aspect-auto" alt="Screenshot" width={1280} height={720} src={item.url} />
                </CarouselItem>
              ))}
            </CarouselContent>
            <CarouselPrevious className="max-lg:hidden left-0 -translate-x-1/2 w-8 h-8" />
            <CarouselNext className="max-lg:hidden right-0 translate-x-1/2 w-8 h-8" />
          </Carousel>
        </>
      )}

      <div className="flex max-lg:flex-col mt-6">
        <div className="lg:basis-2/3 lg:pr-6">
          <h3 className="font-bold text-xl mt-6 border-b pb-2">説明</h3>
          <p className="mt-4 whitespace-pre-wrap" style={{ wordWrap: "break-word" }}>
            {pkg.description}
          </p>
          {selectedRelease && (
            <>
              <h3 className="font-bold text-xl mt-6 border-b pb-2">{selectedVersion === defaultVersion ? "最新のリリース" : "選択されているリリース"}</h3>
              <p className="mt-4 whitespace-pre-wrap" style={{ wordWrap: "break-word" }}>
                {selectedRelease.title}<br />
                {selectedRelease.description}
              </p>
            </>
          )}
        </div>
        <div className="lg:basis-1/3">
          <h4 className="font-bold text-lg mt-6 border-b pb-2">詳細</h4>
          <div className="flex gap-2 flex-col my-4">
            <h4>タグ</h4>
            <div className="flex gap-1 flex-wrap">
              {pkg.tags.map((tag) => (<Badge key={tag}>{tag}</Badge>))}
            </div>
          </div>
          <Separator />
          <div className="flex gap-2 my-4 justify-between">
            <h4>作者</h4>
            <Button asChild variant="link" className="p-0 h-auto" >
              <Link href={`/${lang}/publishers/${pkg.user.Profile?.userName}`}>{pkg.user.Profile?.userName}</Link>
            </Button>
          </div>
          <Separator />
          <div className="flex gap-2 my-4 justify-between">
            <h4>{selectedVersion === defaultVersion ? "最新のバージョン" : "選択されているバージョン"}</h4>
            <p>{selectedVersion}</p>
          </div>
          <Separator />
          <div className="flex gap-2 my-4 justify-between">
            <h4>ターゲットバージョン</h4>
            <p>{selectedRelease?.targetVersion}</p>
          </div>
        </div>
      </div>
    </div>
  )
}