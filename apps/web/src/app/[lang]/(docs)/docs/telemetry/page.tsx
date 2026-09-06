import type { Metadata } from "next";
import { EnglishTelemetryPage } from "./english";

type Props = {
  params: Promise<{ lang: string }>;
};

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { lang } = await props.params;
  return lang === "en"
    ? {
        title: "Telemetry Policy | Beutl",
        description: "Telemetry collected by the Beutl desktop application.",
      }
    : {
        title: "テレメトリーポリシー | Beutl",
        description: "Beutlデスクトップアプリのテレメトリーについて説明します。",
      };
}

const headingClass =
  "mt-10 scroll-m-20 text-2xl font-semibold tracking-tight";
const listClass = "my-6 ml-6 list-disc [&>li]:mt-2";
const linkClass = "underline underline-offset-4 hover:text-primary";

export default async function Page(props: Props) {
  const { lang } = await props.params;
  if (lang === "en") return <EnglishTelemetryPage />;

  return (
    <article className="max-w-5xl mx-auto py-10 lg:py-6 px-4 lg:px-6 bg-card lg:rounded-lg border text-card-foreground lg:my-4">
      <h1 className="scroll-m-20 border-b pb-2 text-3xl font-semibold tracking-tight first:mt-0">
        テレメトリーポリシー
      </h1>
      <p className="mt-4 text-sm text-muted-foreground">
        最終改定日：2026年9月6日
      </p>
      <p className="leading-7 not-first:mt-6">
        この文書はBeutlデスクトップアプリを対象としています。Beutlの品質向上のため、個人を直接識別することを目的としない利用状況データ（以下「テレメトリーデータ」といいます。）を収集する場合があります。
      </p>

      <h2 className={headingClass}>1. 収集するデータ</h2>
      <p className="leading-7 not-first:mt-6">
        テレメトリーデータには、主に次の情報が含まれます。
      </p>
      <ul className={listClass}>
        <li>アプリケーションのエラー及び障害に関するログ</li>
        <li>処理時間、応答時間その他の性能情報</li>
        <li>機能の利用状況及びアプリケーションの動作状況</li>
        <li>アプリケーション、OS及び実行環境のバージョン等の技術情報</li>
      </ul>

      <h2 className={headingClass}>2. 利用目的</h2>
      <p className="leading-7 not-first:mt-6">
        テレメトリーデータは、不具合の発見及び調査、性能と安定性の改善、セキュリティ上の問題の監視、利用状況の集計並びに機能改善のために利用します。
      </p>

      <h2 className={headingClass}>3. 送信先、保存先及び保存期間</h2>
      <p className="leading-7 not-first:mt-6">
        テレメトリーデータは、Raintank, Inc.がGrafana Labsの名称で運営するGrafana Cloudへ送信され、同サービス上に保存されます。Grafana Cloudでは、テレメトリーデータをログ、メトリクス、トレース等として処理する場合があります。
      </p>
      <p className="leading-7 not-first:mt-6">
        データは、運営者が選択したGrafana Cloudスタックのリージョン及び同社の再委託先で取り扱われる場合があります。保存期間は、運営者がGrafana Cloudで設定する保持期間及び障害調査等に必要な期間に従います。
      </p>
      <p className="leading-7 not-first:mt-6">
        Grafana Labsにおける取扱いについては、
        <a
          className={linkClass}
          href="https://grafana.com/legal/privacy-policy/"
          target="_blank"
          rel="noreferrer"
        >
          Grafana Labs Privacy Policy
        </a>
        を確認してください。
      </p>

      <h2 className={headingClass}>4. 収集の停止</h2>
      <p className="leading-7 not-first:mt-6">
        テレメトリーデータの送信は、Beutlの「設定 &gt; 情報 &gt; テレメトリ」から停止できます。停止後も、停止前に送信済みのデータは、設定された保存期間が終了するまで残る場合があります。
      </p>
    </article>
  );
}
