import Image from "next/image";
import Link from "next/link";

export default function Footer() {
  return (
    <div className="bg-secondary">
      <div className="container mx-auto px-6 py-6 md:px-12">
        <div className="flex gap-8">
          <Link href="https://github.com/b-editor">
            <Image width={24} height={24} alt="GitHub" className="w-5 h-5 invert" src="/img/github-color.svg" />
          </Link>
          <Link href="https://x.com/yuto_daisensei">
            <Image width={24} height={24} alt="X" className="w-5 h-5 invert" src="/img/x.svg" />
          </Link>
          <Link href="https://discord.gg/Bm3pnVc928">
            <Image width={24} height={24} alt="X" className="w-5 h-5 invert" src="/img/discord.svg" />
          </Link>
        </div>
        <div className="mt-8 flex gap-3 flex-wrap">
          <Link href="/docs/privacy">プライバシーポリシー</Link>
          <Link href="/docs/telemetry">テレメトリー</Link>
          <Link href={`https://beutl-docs.beditor.net`}>ドキュメント</Link>
        </div>
        <p className="text-end mt-6">© 2020-2024 b-editor</p>
      </div>
    </div>
  )
}