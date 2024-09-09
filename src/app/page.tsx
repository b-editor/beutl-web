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

export default function Home() {
  return (
    <div>
      <NavBar />
      <div>
        <div className={cn(styles.fluid, "m-auto blur-xl absolute top-0 left-1/2 -translate-x-1/2 max-md:translate-y-1/2 select-none pointer-events-none -z-10")} />

        <div className="container mx-auto p-12">

          <h1 className="scroll-m-20 text-4xl font-extrabold tracking-tight lg:text-5xl lg:mt-8 overflow-hidden">
            想像力を解き放つ
          </h1>
          <h2 className="scroll-m-20 mt-8 pb-2 text-xl md:text-3xl font-medium tracking-tight">
            無料でオープンソースの動画編集ソフト
          </h2>
          <Button className="mt-6 border"><Download className="w-5 h-5 mr-2" />ダウンロード</Button>
          <Button variant="link" className="mt-6 text-foreground ml-4 border">
            <img src="/img/github-color.svg" alt="GitHub" className="w-5 h-5 mr-2 invert" />
            GitHub
          </Button>

          <div className="mt-8 mx-auto select-none pointer-events-none">
            <Image className="scale-[107.5%]" src="/img/brand-image2.png" alt="brand image" width={1920} height={1080} />
          </div>
        </div>

        <div className="bg-[hsl(var(--card)/60%)] py-4" />
        <ToggleGroup type="single" defaultValue="a" className="md:sticky max-md:hidden top-[calc(3.5rem+1px)] z-10 bg-[hsl(var(--card)/60%)] mx-auto p-3 gap-2 backdrop-blur-lg">
          <ToggleGroupItem value="a">クロスプラットフォーム</ToggleGroupItem>
          <ToggleGroupItem value="b">アニメーション</ToggleGroupItem>
          <ToggleGroupItem value="c">エフェクト</ToggleGroupItem>
          <ToggleGroupItem value="d">拡張機能</ToggleGroupItem>
        </ToggleGroup>
        <div className="md:hidden bg-[hsl(var(--card)/60%)]">
        <Select defaultValue="a">
          <SelectTrigger className="w-[240px] mx-auto bg-transparent">
            <SelectValue placeholder="Select a fruit" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="a">クロスプラットフォーム</SelectItem>
              <SelectItem value="b">アニメーション</SelectItem>
              <SelectItem value="c">エフェクト</SelectItem>
              <SelectItem value="d">拡張機能</SelectItem>
            </SelectGroup>
          </SelectContent>
          </Select>
        </div>
        <div className="bg-[hsl(var(--card)/60%)] py-4" />

        <div className="container mx-auto p-12 grid lg:grid-cols-2 gap-4">

          <div className="mt-8">
            <h3 className="scroll-m-20 text-2xl md:text-4xl font-semibold tracking-tight">
              クロスプラットフォーム
            </h3>
            <p className="mt-8 text-lg leading-8">
              Windows専用のソフトにはうんざりしていませんか？<br />
              Beutl は常に最新の .NET を使用しているため、いろいろな OS で動作します。 Windows, Linux, macOSをサポートしています。
            </p>
          </div>

          <div className="mt-8 ">
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
