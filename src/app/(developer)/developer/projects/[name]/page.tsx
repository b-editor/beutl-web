import NavBar from "@/components/nav-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Carousel, CarouselContent, CarouselItem, CarouselPrevious } from "@/components/ui/carousel";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import api from "@/lib/api";
import { Edit, EyeOff, MoreVertical } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { PackageInfoForm } from "./component";

const extension = {
  name: "FFmpeg配置ツール",
  description: "FFmpegのライブラリ、実行ファイル群を自動で配置します。",
  image: "https://beutl.beditor.net/api/v1/assets/b-editor/ffmpeg-locator.png/download",
  borderGradient: "linear-gradient(135deg, #5C9A55 0%, #5E84E7 50%, #7B59F6 100%)"
};

export default async function Page({ params: { name } }: { params: { name: string } }) {
  const pkg = await api.packages.getPackage(name);

  return (
    <div className="max-w-5xl mx-auto py-10 lg:py-6 px-4 lg:px-6 bg-card lg:rounded-lg border text-card-foreground lg:my-4">
      <PackageInfoForm pkg={pkg} />

      {/* {pkg.screenshots && Object.entries(pkg.screenshots).length > 0 && (
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
      )} */}

      <div className="flex max-lg:flex-col mt-6">
        {/* <div className="lg:basis-2/3 lg:pr-6">
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
        </div> */}
        {/* <div className="lg:basis-1/3">
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
        </div> */}
      </div>
    </div>
  )
}
