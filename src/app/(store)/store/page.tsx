import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import Image from "next/image";

const extensions = [
  {
    name: "FFmpeg配置ツール",
    description: "FFmpegのライブラリ、実行ファイル群を自動で配置します。",
    image: "https://beutl.beditor.net/api/v1/assets/b-editor/ffmpeg-locator.png/download",
    borderGradient: "linear-gradient(135deg, #5C9A55 0%, #5E84E7 50%, #7B59F6 100%)"
  },
  {
    name: "Sugar Shaker",
    description: "キーフレームを使わずに、フェードインアウトなどのアニメーション効果を付けられるようにします。",
    image: "https://beutl.beditor.net/api/v1/assets/b-editor/sugar-shaker-logo.jpg/download",
    borderGradient: "linear-gradient(135deg, #ffffff 0%, #090C1D 50%, #ffffff 100%)"
  },
  {
    name: "Cefサンプル",
    description: "Cefを使ったブラウザをページに追加します。",
    image: "https://beutl.beditor.net/api/v1/assets/b-editor/icon/download",
    borderGradient: "linear-gradient(135deg, #693AF4 0%, #D0D2D2 100%)"
  }
];

export default function Page() {
  return (
    <>
      <div className="border-b bg-card">
        <div className="container max-w-7xl mx-auto py-6 flex flex-col">
          <h2 className="text-3xl font-semibold mx-4">拡張機能を探す</h2>
          <Input className="my-4 mx-4 max-md:w-auto md:max-w-md" />
        </div>
      </div>
      <div className="container max-w-7xl mx-auto py-6 px-2">
        <div className="flex flex-wrap">
          {extensions.map(item => (
            <a href="/" className="text-start p-2 basis-full sm:basis-1/2 md:basis-1/3" key={item.name}>
              <Card className="h-full">
                <CardContent className="p-6 h-full flex flex-col gap-2 justify-between">
                  <div>
                    <div className="flex w-full">
                      <div className="flex-[3]">
                        <h4 className="text-xl font-semibold">{item.name}</h4>
                        <span className="text-muted">公式パッケージ</span>
                      </div>
                      <Image width={64} height={64}
                        className="flex-1 w-16 h-16 max-w-fit rounded-md"
                        alt="Package icon" src={item.image} />
                    </div>
                    <p className="text-sm mt-4">{item.description}</p>
                  </div>
                  <div className="overflow-x-clip relative h-6">
                    <div className="flex gap-2 absolute">
                      <Badge variant="secondary" className="text-nowrap">無料</Badge>
                      <Separator orientation="vertical" className="h-auto my-1" />
                      <Badge variant="outline" className="border-input text-nowrap">ツール</Badge>
                      <Badge variant="outline" className="border-input text-nowrap">ツール</Badge>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </a>
          ))}
        </div>
      </div>
    </>
  )
}