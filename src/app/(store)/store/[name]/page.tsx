import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from "@/components/ui/carousel";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { MoreVertical } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

export default function Page({ params: { name } }: { params: { name: string } }) {
  return (
    <div className="max-w-5xl mx-auto py-10 lg:py-6 px-4 lg:px-6 bg-card lg:rounded-lg border text-card-foreground lg:my-4">
      <div className="max-sm:relative sm:flex sm:gap-2">
        <div className="w-full flex justify-between gap-4 max-sm:flex-col">
          <div className="flex gap-4">
            <Image width={64} height={64}
              className="w-16 h-16 max-w-fit rounded-md"
              alt="Package icon" src="https://beutl.beditor.net/api/v1/assets/b-editor/ffmpeg-locator.png/download" />
            <div>
              <h2 className="font-bold text-2xl">FFmpeg配置ツール</h2>
              <Button asChild variant="link" className="p-0 h-auto text-muted-foreground">
                <Link href="/">b-editor</Link>
              </Button>
            </div>
          </div>
          <Button>入手</Button>
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
            <DropdownMenuRadioGroup>
              <DropdownMenuRadioItem value="1.0.1">1.0.1</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="1.0.0">1.0.0</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem>コンテンツを報告</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className="mt-4 text-foreground/70">FFmpegのライブラリ、実行ファイル群を自動で配置します。</p>

      <h3 className="font-bold text-xl mt-6 border-b pb-2">スクリーンショット</h3>
      <Carousel className="mt-4">
        <CarouselContent>
          {Array.from({ length: 2 }).map((_, i) => (
            <CarouselItem className="w-min max-w-min min-w-min" key={i}>
              <Image className="rounded max-w-min h-80 aspect-auto" alt="Screenshot" width={1280} height={720} src="https://beutl.beditor.net/api/v1/assets/b-editor/ffmpeg-locator-screenshot.png/download" />
            </CarouselItem>
          ))}
          <CarouselItem className="">
            <Image className="rounded max-w-min h-80 aspect-auto" alt="Screenshot" width={1280} height={720} src="https://beutl.beditor.net/api/v1/assets/b-editor/sugar-shaker-screenshot-1.jpg/download" />
          </CarouselItem>
        </CarouselContent>
        <CarouselPrevious className="max-lg:hidden left-0 -translate-x-1/2 w-8 h-8" />
        <CarouselNext className="max-lg:hidden right-0 translate-x-1/2 w-8 h-8" />
      </Carousel>

      <div className="flex max-lg:flex-col mt-6">
        <div className="lg:basis-2/3 lg:pr-6">
          <h3 className="font-bold text-xl mt-6 border-b pb-2">説明</h3>
          <p className="mt-4 whitespace-pre-wrap" style={{ wordWrap: "break-word" }}>
            {`Beutlをより簡単に使うための拡張機能です。
キーフレームを使わずに、フェードインアウトなどのアニメーション効果を付けられるようにします。

以下のエフェクトが追加されます
- フェードインアウト
- ワイプ
- 透明にする`}
          </p>
          <h3 className="font-bold text-xl mt-6 border-b pb-2">最新のリリース</h3>
          <p className="mt-4 whitespace-pre-wrap" style={{ wordWrap: "break-word" }}>
            1.0.0
          </p>
        </div>
        <div className="lg:basis-1/3">
          <h4 className="font-bold text-lg mt-6 border-b pb-2">詳細</h4>
          <div className="flex gap-2 flex-col my-4">
            <h4>タグ</h4>
            <div className="flex gap-1 flex-wrap">
              <Badge>effect</Badge>
              <Badge>animation</Badge>
              <Badge>source-operator</Badge>
              <Badge>filter</Badge>
              <Badge>filter</Badge>
              <Badge>filter</Badge>
              <Badge>filter</Badge>
            </div>
          </div>
          <Separator />
          <div className="flex gap-2 my-4 justify-between">
            <h4>作者</h4>
            <Button asChild variant="link" className="p-0 h-auto" >
              <Link href="/">b-editor</Link>
            </Button>
          </div>
          <Separator />
          <div className="flex gap-2 my-4 justify-between">
            <h4>最新のバージョン</h4>
            <p>1.0.0</p>
          </div>
          <Separator />
          <div className="flex gap-2 my-4 justify-between">
            <h4>ターゲットバージョン</h4>
            <p>1.0.0-preview.3</p>
          </div>
        </div>
      </div>
    </div>
  )
}