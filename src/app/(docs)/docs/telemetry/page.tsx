export default function Page() {
  return (
    <div className="max-w-5xl mx-auto py-10 lg:py-6 px-4 lg:px-6 bg-card lg:rounded-lg border text-card-foreground lg:my-4">
      <h2 className="scroll-m-20 border-b pb-2 text-3xl font-semibold tracking-tight first:mt-0">
        テレメトリー
      </h2>
      <p className="leading-7 [&:not(:first-child)]:mt-6">
        この文書は Beutlデスクトップアプリを対象としています。<br />
        Beutlを改善するために、匿名の使用状況データを収集します。<br />
        以下に、このテレメトリデータに関する重要な情報を示します。
      </p>

      <h3 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        1. 収集されるデータ
      </h3>
      <p className="leading-7 [&:not(:first-child)]:mt-6">
        テレメトリデータには、製品やサービスの使用に関する情報が含まれます。
        これには、アプリケーションのエラーログ、パフォーマンスデータ、利用状況の統計などが含まれます。
      </p>

      <h3 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        2. データの収集目的
      </h3>
      <p className="leading-7 [&:not(:first-child)]:mt-6">
        テレメトリデータは、製品やサービスの品質向上、トラブルシューティング、セキュリティの監視、サービスの最適化など、さまざまな目的で収集されます。
      </p>

      <h3 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        3. データの保存場所
      </h3>
      <p className="leading-7 [&:not(:first-child)]:mt-6">
        テレメトリデータは、Azure Monitorを介して収集され、マイクロソフトのサーバーに保存されます。
        これらのサーバーは適切なセキュリティ対策が施されており、データの保護を確保するための対策が講じられています。
      </p>

      <h3 className="mt-8 scroll-m-20 text-2xl font-semibold tracking-tight">
        4. オプトアウト
      </h3>
      <p className="leading-7 [&:not(:first-child)]:mt-6">
        テレメトリデータの収集を個別に拒否する場合、&apos;設定&gt;情報&gt;テレメトリ&apos;から拒否できます。
      </p>

    </div>
  )
}