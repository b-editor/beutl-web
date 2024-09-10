import Image from "next/image";

export default function Footer() {
  return (
    <div className="bg-secondary">
      <div className="container mx-auto px-6 py-6 md:px-12">
        <div className="flex gap-8">
          <a href="https://github.com/b-editor">
            <Image width={24} height={24} alt="GitHub" className="w-5 h-5 invert" src="/img/github-color.svg" />
          </a>
          <a href="https://github.com/b-editor">
            <Image width={24} height={24} alt="X" className="w-5 h-5 invert" src="/img/x.svg" />
          </a>
          <a href="https://github.com/b-editor">
            <Image width={24} height={24} alt="X" className="w-5 h-5 invert" src="/img/discord.svg" />
          </a>
        </div>
        <div className="mt-8 flex gap-3 flex-wrap">
          <a href="/">プライバシーポリシー</a>
          <a href="/">テレメトリー</a>
          <a href="/">ドキュメント</a>
        </div>
        <p className="text-end mt-6">© 2020-2024 b-editor</p>
      </div>
    </div>
  )
}