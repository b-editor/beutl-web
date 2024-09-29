"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from "@/components/ui/carousel";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import type { ReleaseResponse, PackageResponse } from "@/lib/api";
import { Loader2, MoreVertical } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { handleGet } from "./actions";

function GetButton({pkgName}: {pkgName: string}) {
  const [pending, setPending] = useState(false);

  return (
    <Button onClick={async () => {
      setPending(true);
      try {
        await handleGet(pkgName);
      } finally {
        setPending(false);
      }
    }}>
      {pending && <Loader2 className="mr-2 w-4 h-4 animate-spin" />}
      入手
    </Button>
  )
}

export function ClientPage({ pkg, releases }: { pkg: PackageResponse, releases: ReleaseResponse[] }) {
  const defaultVersion = useMemo(() => releases.length > 0 ? releases[0].version : undefined, [releases]);
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedVersion = useMemo(() => searchParams.get("v") || defaultVersion, [searchParams, defaultVersion]);
  const selectedRelease = useMemo(() => {
    if (selectedVersion) {
      return releases.find(v => v.version === selectedVersion);
    }
  }, [selectedVersion, releases]);

  return (
    <div className="max-w-5xl mx-auto py-10 lg:py-6 px-4 lg:px-6 bg-card lg:rounded-lg border text-card-foreground lg:my-4">
      <div className="max-sm:relative sm:flex sm:gap-2">
        <div className="w-full flex justify-between gap-4 max-sm:flex-col">
          <div className="flex gap-4">
            <Image width={64} height={64}
              className="w-16 h-16 max-w-fit rounded-md"
              alt="Package icon" src={pkg.logo_url ?? ""} />
            <div>
              <h2 className="font-bold text-2xl">{pkg.display_name}</h2>
              <Button asChild variant="link" className="p-0 h-auto text-muted-foreground">
                <Link href="/">{pkg.owner.name}</Link>
              </Button>
            </div>
          </div>
          <GetButton pkgName={pkg.name} />
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
              {releases.map((release) => (
                <DropdownMenuRadioItem value={release.version} key={release.id}>
                  {release.version}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem>コンテンツを報告</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className="mt-4 text-foreground/70">{pkg.short_description}</p>

      {pkg.screenshots && Object.entries(pkg.screenshots).length > 0 && (
        <>
          <h3 className="font-bold text-xl mt-6 border-b pb-2">スクリーンショット</h3>
          <Carousel className="mt-4">
            <CarouselContent>
              {Object.entries(pkg.screenshots).map((item) => (
                <CarouselItem className="w-min max-w-min min-w-min" key={item[0]}>
                  <Image className="rounded max-w-min h-80 aspect-auto" alt="Screenshot" width={1280} height={720} src={item[1]} />
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
                {selectedRelease.body}
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
              <Link href="/">{pkg.owner.name}</Link>
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
            <p>{selectedRelease?.target_version}</p>
          </div>
        </div>
      </div>
    </div>
  )
}