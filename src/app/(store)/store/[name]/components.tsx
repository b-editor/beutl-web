"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from "@/components/ui/carousel";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { MoreVertical } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import type { retrievePackage } from "./actions";

function GetButton({ pkgName, owned }: { pkgName: string, owned: boolean }) {
  const router = useRouter();

  return (
    <Button disabled={owned} onClick={() => router.push(`/store/${pkgName}/get`)}>
      {owned ? "入手済" : "入手"}
    </Button>
  )
}

export function ClientPage({ pkg, owned }: { pkg: NonNullable<Awaited<ReturnType<typeof retrievePackage>>>, owned: boolean }) {
  const defaultVersion = useMemo(() => pkg.Release.length > 0 ? pkg.Release[0].version : undefined, [pkg.Release]);
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedVersion = useMemo(() => searchParams.get("v") || defaultVersion, [searchParams, defaultVersion]);
  const selectedRelease = useMemo(() => {
    if (selectedVersion) {
      return pkg.Release.find(v => v.version === selectedVersion);
    }
  }, [selectedVersion, pkg.Release]);

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
                <Link href="/">{pkg.user.Profile?.userName}</Link>
              </Button>
            </div>
          </div>
          <GetButton pkgName={pkg.name} owned={owned} />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="max-sm:absolute max-sm:right-0 top-0">
              <MoreVertical className="w-4 h-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
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
      </div>
      <p className="mt-4 text-foreground/70">{pkg.shortDescription}</p>

      {pkg.PackageScreenshot && pkg.PackageScreenshot.length > 0 && (
        <>
          <h3 className="font-bold text-xl mt-6 border-b pb-2">スクリーンショット</h3>
          <Carousel className="mt-4">
            <CarouselContent>
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
              <Link href="/">{pkg.user.Profile?.userName}</Link>
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