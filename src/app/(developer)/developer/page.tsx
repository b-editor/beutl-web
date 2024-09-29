import NavBar from "@/components/nav-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EyeOff } from "lucide-react";
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
    <div>
      <div className="border-b bg-card">
        <div className="container max-w-6xl mx-auto py-12 px-4 flex flex-col gap-12">
          <h2 className="text-3xl font-semibold">拡張機能を開発する</h2>
          <div className="flex gap-2">
            <Button>新しい拡張機能を作成</Button>
            <Button variant="outline">ドキュメント</Button>
          </div>
        </div>
      </div>

      <div className="container max-w-6xl mx-auto py-12 px-4 flex flex-col">
        <h2 className="text-xl font-semibold">プロジェクト</h2>
        <div className="flex flex-wrap -mx-2">
          {extensions.map(item => (
            <a href="/" className="text-start p-2 basis-full md:basis-1/2 lg:basis-1/3" key={item.name}>
              <Card className="h-full">
                <CardContent className="p-6 h-full flex flex-col gap-2 justify-between">
                  <div>
                    <div className="flex w-full">
                      <div className="flex-[3]">
                        <h4 className="text-xl font-semibold">{item.name}</h4>
                        <span className="text-muted">Package Id</span>
                      </div>
                      <Image width={40} height={40}
                        className="flex-1 w-10 h-10 max-w-fit rounded-md"
                        alt="Package icon" src={item.image} />
                    </div>
                    <div className="mt-4 flex gap-2">
                      <Badge variant="secondary">1.0.0</Badge>
                      <Badge variant="secondary"><EyeOff className="w-4 h-4" /></Badge>
                    </div>
                    {/* <p className="text-sm mt-4">{item.description}</p> */}
                  </div>
                </CardContent>
              </Card>
            </a>
          ))}
        </div>
      </div>
    </div>
  )
}
