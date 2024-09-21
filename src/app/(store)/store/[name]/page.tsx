import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import Image from "next/image";

export default function Page({ params: { name } }: { params: { name: string } }) {
  return (
    <div className="max-w-5xl mx-auto py-6 px-4">
      <div className="flex justify-between gap-4 max-sm:flex-col">
        <div className="flex gap-4">
          <Image width={64} height={64}
            className="w-16 h-16 max-w-fit rounded-md"
            alt="Package icon" src="https://beutl.beditor.net/api/v1/assets/b-editor/ffmpeg-locator.png/download" />
          <h2 className="font-bold text-2xl">FFmpeg配置ツール</h2>
        </div>

        <Button>インストール</Button>
      </div>
      <p className="mt-4 text-foreground/70">FFmpegのライブラリ、実行ファイル群を自動で配置します。</p>

      <h3 className="font-bold text-xl mt-6 border-b pb-2">スクリーンショット</h3>
      <div className="flex max-md:flex-col mt-6">
        <div className="md:basis-2/3 pr-6">
          <h3 className="font-bold text-xl mt-6 border-b pb-2">説明</h3>
          <h3 className="font-bold text-xl mt-6 border-b pb-2">最新のリリース</h3>
        </div>
        <div>
          <h4 className="font-bold text-lg mt-6">詳細</h4>
        </div>
      </div>
    </div>
  )
}