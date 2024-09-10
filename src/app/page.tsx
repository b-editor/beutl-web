import NavBar from "@/components/nav-bar";
import SignIn from "@/components/sign-in";
import Image from "next/image";
import styles from './styles.module.css'
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Download, Github } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import FeaturesToc from "@/components/features-toc";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import EasingDemo from "@/components/easing-demo";
import EffectsDemo from "@/components/effects-demo";

export default function Home() {
  return (
    <div>
      <NavBar />
      <div>
        <div className={cn(styles.fluid, "m-auto w-[70vw] h-[70vw] md:w-[50vw] md:h-[50vw] blur-md md:blur-xl absolute top-0 left-1/2 -translate-x-1/2 max-md:translate-y-1/2 select-none pointer-events-none -z-10")} />

        <div className="container mx-auto px-6 pt-12 md:px-12">

          <h1 className="scroll-m-20 text-4xl font-extrabold tracking-tight lg:text-5xl lg:mt-8 overflow-hidden">
            想像力を解き放つ
          </h1>
          <h2 className="scroll-m-20 mt-8 pb-2 text-xl md:text-3xl font-medium tracking-tight">
            無料でオープンソースの動画編集ソフト
          </h2>
          <Button className="mt-6 border"><Download className="w-5 h-5 mr-2" />ダウンロード</Button>
          <Button variant="link" className="mt-6 text-foreground ml-4 border backdrop-brightness-75">
            <img src="/img/github-color.svg" alt="GitHub" className="w-5 h-5 mr-2 invert" />
            GitHub
          </Button>

          <div className="mt-16 md:mt-8 mx-auto select-none pointer-events-none">
            <Image className="scale-[107.5%]" src="/img/brand-image2.png" alt="brand image" width={1920} height={1080} />
          </div>
        </div>

        <div className="bg-[hsl(var(--card)/60%)] py-4" />
        {/* <ToggleGroup type="single" className="md:sticky mx-auto p-3 flex-wrap top-[calc(3.5rem+1px)] z-10 bg-[hsl(var(--card)/60%)] gap-2 backdrop-blur-lg">
          <ToggleGroupItem value="a">クロスプラットフォーム</ToggleGroupItem>
          <ToggleGroupItem value="b">アニメーション</ToggleGroupItem>
          <ToggleGroupItem value="c">エフェクト</ToggleGroupItem>
          <ToggleGroupItem value="d">拡張機能</ToggleGroupItem>
        </ToggleGroup> */}
        <FeaturesToc />
        <div className="bg-[hsl(var(--card)/60%)] py-4" />

        <div className="container mx-auto px-6 py-12 md:px-12 flex max-lg:flex-col lg:items-center gap-8">

          <div className="lg:flex-1">
            <h3 id="features-cross-platform" className="features-header scroll-mt-20 md:scroll-mt-36 text-2xl md:text-4xl font-semibold tracking-tight">
              クロスプラットフォーム
            </h3>
            <p className="mt-8 text-lg leading-8">
              Windows専用のソフトにはうんざりしていませんか？<br />
              Beutl は常に最新の .NET を使用しているため、いろいろな OS で動作します。 Windows, Linux, macOSをサポートしています。
            </p>
            <Popover>
              <PopoverTrigger asChild>
                <Button className="mt-8" variant="outline">動作確認済みOS</Button>
              </PopoverTrigger>
              <PopoverContent className="w-80">
                <div className="grid gap-4">
                  <div className="space-y-2">
                    <h4 className="font-medium leading-none">動作確認済みOS</h4>
                  </div>
                  <div>
                    <h5 className="border-b pb-2 text-lg font-semibold tracking-tight">
                      Windows
                    </h5>
                    <ul className="list-disc list-inside mt-2">
                      <li className="text-sm">Windows 11</li>
                    </ul>
                    <h5 className="border-b pb-2 text-lg font-semibold tracking-tight mt-4">
                      macOS
                    </h5>
                    <ul className="list-disc list-inside mt-2">
                      <li className="text-sm">macOS Sonoma 14.6.1</li>
                    </ul>
                    <h5 className="border-b pb-2 text-lg font-semibold tracking-tight mt-4">
                      Linux
                    </h5>
                    <ul className="list-disc list-inside mt-2">
                      <li className="text-sm">Zorin OS 16</li>
                      <li className="text-sm">Ubuntu 22.04</li>
                    </ul>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          </div>

          <div className="lg:flex-1">
            <Image className="rounded" src="/img/cross-platform.png" alt="Cross platform" width={1920} height={1315} />
          </div>

        </div>
        <div className="container mx-auto px-6 py-12 md:px-12 flex max-lg:flex-col lg:flex-row-reverse lg:items-center gap-8">

          <div className="lg:flex-1">
            <h3 id="features-animation" className="features-header scroll-mt-20 md:scroll-mt-36 text-2xl md:text-4xl font-semibold tracking-tight">
              アニメーション
            </h3>
            <p className="mt-8 text-lg leading-8">
              キーフレームを使用して、フェードインアウト、スライドインなど基本的なアニメーションや、
              さまざまなオブジェクトをアニメーションすることができます。
            </p>
          </div>

          <div className="lg:flex-1">
            <div className="grid grid-cols-3 gap-4">
              <EasingDemo type="in" path="M1 84c14 1 47.75 1 123-83" easing="cubic-bezier(.12,0,.39,0)" />
              <EasingDemo type="out" path="M1 84C76.25 0 110 0 124 1" easing="cubic-bezier(.61,1,.88,1)" />
              <EasingDemo type="inOut" path="M1 84C46.25 85 78.75 0 124 1" easing="cubic-bezier(.37,0,.63,1)" />
            </div>
          </div>

        </div>
        <div className="container mx-auto px-6 pt-12 md:px-12 lg:items-center gap-8">
          <h3 id="features-effects" className="features-header text-center scroll-mt-20 md:scroll-mt-36 text-2xl md:text-4xl font-semibold tracking-tight">
            豊富なエフェクト
          </h3>
          <p className="mt-8 text-lg leading-8 ">
            色フィルター、ぼかし、シャドウ、LUT などの基本的なエフェクトから 縁取り、内側シャドウ、ロングシャドウなどのマイナーなエフェクトがあります。
            もちろんこれらは拡張機能で増やすことができます。
          </p>
          <EffectsDemo />
        </div>
        <div className="container mx-auto px-6 py-12 md:px-12 flex max-lg:flex-col lg:flex-row-reverse lg:items-center gap-8">

          <div className="lg:flex-1">
            <h3 id="features-extensions" className="features-header scroll-mt-20 md:scroll-mt-36 text-2xl md:text-4xl font-semibold tracking-tight">
              拡張機能
            </h3>
            <p className="mt-8 text-lg leading-8">
              Beutl アカウントを作成して、拡張機能を取得したり、自身で開発した拡張機能を公開できます。
              拡張機能では、エフェクト、オブジェクト、コーデック、UIなどを追加できます。
            </p>
          </div>

          <div className="lg:flex-1">
            <Image className="scale-[107.5%]" src="/img/brand-image2.png" alt="brand image" width={1920} height={1080} />
          </div>

        </div>
      </div>

    </div>
    // <div className="grid grid-rows-[20px_1fr_20px] items-center justify-items-center min-h-screen p-8 pb-20 gap-16 sm:p-20 font-[family-name:var(--font-geist-sans)]">
    //   <main className="flex flex-col gap-8 row-start-2 items-center sm:items-start">
    //     <Image
    //       className="dark:invert"
    //       src="https://nextjs.org/icons/next.svg"
    //       alt="Next.js logo"
    //       width={180}
    //       height={38}
    //       priority
    //     />
    //     <ol className="list-inside list-decimal text-sm text-center sm:text-left font-[family-name:var(--font-geist-mono)]">
    //       <li className="mb-2">
    //         Get started by editing{" "}
    //         <code className="bg-black/[.05] dark:bg-white/[.06] px-1 py-0.5 rounded font-semibold">
    //           app/page.tsx
    //         </code>
    //         .
    //       </li>
    //       <li>Save and see your changes instantly.</li>
    //     </ol>

    //     <div className="flex gap-4 items-center flex-col sm:flex-row">
    //       <SignIn /> 
    //     </div>
    //   </main>
    //   <footer className="row-start-3 flex gap-6 flex-wrap items-center justify-center">
    //     <a
    //       className="flex items-center gap-2 hover:underline hover:underline-offset-4"
    //       href="https://nextjs.org/learn?utm_source=create-next-app&utm_medium=appdir-template-tw&utm_campaign=create-next-app"
    //       target="_blank"
    //       rel="noopener noreferrer"
    //     >
    //       <Image
    //         aria-hidden
    //         src="https://nextjs.org/icons/file.svg"
    //         alt="File icon"
    //         width={16}
    //         height={16}
    //       />
    //       Learn
    //     </a>
    //     <a
    //       className="flex items-center gap-2 hover:underline hover:underline-offset-4"
    //       href="https://vercel.com/templates?framework=next.js&utm_source=create-next-app&utm_medium=appdir-template-tw&utm_campaign=create-next-app"
    //       target="_blank"
    //       rel="noopener noreferrer"
    //     >
    //       <Image
    //         aria-hidden
    //         src="https://nextjs.org/icons/window.svg"
    //         alt="Window icon"
    //         width={16}
    //         height={16}
    //       />
    //       Examples
    //     </a>
    //     <a
    //       className="flex items-center gap-2 hover:underline hover:underline-offset-4"
    //       href="https://nextjs.org?utm_source=create-next-app&utm_medium=appdir-template-tw&utm_campaign=create-next-app"
    //       target="_blank"
    //       rel="noopener noreferrer"
    //     >
    //       <Image
    //         aria-hidden
    //         src="https://nextjs.org/icons/globe.svg"
    //         alt="Globe icon"
    //         width={16}
    //         height={16}
    //       />
    //       Go to nextjs.org →
    //     </a>
    //   </footer>
    // </div>
  );
}
