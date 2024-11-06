export default function Page() {
  return (
    <div className="max-w-5xl mx-auto py-10 lg:py-6 px-4 lg:px-6 bg-card lg:rounded-lg border text-card-foreground lg:my-4">
      <h2 className="scroll-m-20 border-b pb-2 text-3xl font-semibold tracking-tight first:mt-0">
        プライバシーポリシー
      </h2>
      <h3 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        1. 収集する情報
      </h3>
      <p className="leading-7 [&:not(:first-child)]:mt-6">
        運営者は、拡張機能のストアサービスを提供するために、以下の情報を収集する場合があります。
      </p>
      <ul className="my-6 ml-6 list-disc [&>li]:mt-2">
        <li>ユーザー名、メールアドレス、およびパスワード</li>
        <li>デバイス情報（デバイスの種類、OSバージョンなど）</li>
        <li>利用履歴や設定情報</li>
        <li>その他ユーザーが提供する情報</li>
      </ul>

      <h3 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        2. 情報の使用
      </h3>
      <p className="leading-7 [&:not(:first-child)]:mt-6">
        収集した情報は、以下の目的で使用されます。
      </p>
      <ul className="my-6 ml-6 list-disc [&>li]:mt-2">
        <li>サービスの提供と運営</li>
        <li>ユーザーサポート提供</li>
        <li>セキュリティ対策</li>
        <li>サービスの改善とカスタマイズ</li>
        <li>法的要件の遵守</li>
      </ul>

      <h3 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        3. 情報の共有
      </h3>
      <p className="leading-7 [&:not(:first-child)]:mt-6">
        運営者は、ユーザーの許可なしに個人情報を第三者と共有しません。ただし、以下の場合に情報を共有することがあります。
      </p>
      <ul className="my-6 ml-6 list-disc [&>li]:mt-2">
        <li>法的要件に従う必要がある場合</li>
        <li>サービス提供に必要な場合</li>
        <li>ユーザーの同意がある場合</li>
      </ul>

      <h3 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        4. クッキーとトラッキング技術
      </h3>
      <p className="leading-7 [&:not(:first-child)]:mt-6">
        運営者は、クッキーや同様のトラッキング技術を使用することがあります。
        これらの技術は、ユーザーエクスペリエンスの向上や統計情報の収集に使用されます。
      </p>

      <h3 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        5. セキュリティ
      </h3>
      <p className="leading-7 [&:not(:first-child)]:mt-6">
        運営者は、ユーザー情報のセキュリティを確保するために適切な物理的、技術的、組織的対策を講じます。
      </p>

      <h3 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        6. プライバシー設定
      </h3>
      <p className="leading-7 [&:not(:first-child)]:mt-6">
        ユーザーは、アカウント設定からプライバシー設定をカスタマイズできます。
      </p>

      <h3 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        8. お問い合わせ
      </h3>
      <p className="leading-7 [&:not(:first-child)]:mt-6">
        プライバシーポリシーに関する質問や要望がある場合、以下の連絡先にご連絡ください。
      </p>
      <p className="leading-7 [&:not(:first-child)]:mt-6">
        連絡先メールアドレス: contact@mail.beditor.net
      </p>

      <h3 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        9. プライバシーポリシーの変更
      </h3>
      <p className="leading-7 [&:not(:first-child)]:mt-6">
        運営者は、必要に応じてプライバシーポリシーを変更することがあります。
        運営者が別途定める場合を除いて、変更後のプライバシーポリシーは、本ページに掲載したときから効力を生じるものとします。
      </p>
    </div>
  )
}