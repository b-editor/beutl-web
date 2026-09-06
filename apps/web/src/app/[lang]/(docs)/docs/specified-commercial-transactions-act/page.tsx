import type { Metadata } from "next";
import Link from "next/link";
import { EnglishCommercialTransactionsPage } from "./english";

type Props = {
  params: Promise<{ lang: string }>;
};

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { lang } = await props.params;
  return {
    title:
      lang === "en"
        ? "Disclosure under the Act on Specified Commercial Transactions | Beutl"
        : "特定商取引法に基づく表記 | Beutl",
  };
}

const headingClass =
  "mt-10 scroll-m-20 text-2xl font-semibold tracking-tight";
const listClass = "my-6 ml-6 list-disc [&>li]:mt-2";

const rows = [
  ["販売事業者", "寺田雄翔"],
  ["運営統括責任者", "寺田雄翔"],
  ["所在地", "請求があった場合、遅滞なく開示します。"],
  ["電話番号", "請求があった場合、遅滞なく開示します。"],
  ["メールアドレス", "contact@beditor.net"],
  [
    "販売価格",
    "各商品又はプランのページに表示します。最終的な支払金額、通貨及び課金間隔は、購入を確定する前の決済画面に表示します。",
  ],
  [
    "商品代金以外に必要な費用",
    "本サービスを利用するためのインターネット接続料金、通信料金その他利用者の利用環境に必要な費用は、利用者の負担となります。",
  ],
  ["支払方法", "クレジットカード（Stripe）"],
  [
    "支払時期",
    "購入手続の完了時に決済されます。定期購入は、購入画面に表示された請求期間ごとに、解約されるまで自動的に決済されます。",
  ],
  [
    "商品の引渡し・サービスの提供時期",
    "ダウンロード商品は決済確認後に利用できます。AIサブスクリプション及び追加クレジットは決済確認後にアカウントへ反映されます。外部決済の通知状況により、反映まで数分かかる場合があります。",
  ],
] as const;

export default async function Page(props: Props) {
  const { lang } = await props.params;
  if (lang === "en") {
    return <EnglishCommercialTransactionsPage lang={lang} />;
  }

  return <JapaneseCommercialTransactionsPage lang={lang} />;
}

function JapaneseCommercialTransactionsPage({ lang }: { lang: string }) {
  return (
    <article className="max-w-5xl mx-auto py-10 lg:py-6 px-4 lg:px-6 bg-card lg:rounded-lg border text-card-foreground lg:my-4">
      <h1 className="scroll-m-20 border-b pb-2 text-3xl font-semibold tracking-tight first:mt-0">
        特定商取引法に基づく表記
      </h1>
      <p className="mt-4 text-sm text-muted-foreground">
        最終更新日：2026年9月6日
      </p>

      <div className="my-6 overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse">
          <tbody>
            {rows.map(([label, value]) => (
              <tr key={label}>
                <th className="w-56 border px-4 py-3 text-left align-top font-semibold">
                  {label}
                </th>
                <td className="border px-4 py-3 text-left align-top">
                  {value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className={headingClass}>定期購入の解約</h2>
      <p className="leading-7 not-first:mt-6">
        AIサブスクリプションは、アカウントの請求管理画面から次回更新前に解約できます。解約後も、画面に表示された現在の利用期限までは対象機能を利用でき、次回以降の自動更新は行われません。現在の利用期間の途中で解約した場合も、法令又は個別に表示する条件で認められる場合を除き、日割り又は月割りによる返金は行いません。
      </p>

      <h2 className={headingClass}>返品、交換及び返金</h2>
      <p className="leading-7 not-first:mt-6">
        デジタル商品及びオンラインサービスの性質上、法令又は購入前に表示した条件で認められる場合を除き、購入確定後の利用者都合による返品、交換又は返金は受け付けません。
      </p>
      <ul className={listClass}>
        <li>
          ダウンロード商品を正常に取得できない場合、又は提供された商品が破損し若しくは表示された内容と著しく異なる場合は、購入後7日以内にcontact@beditor.netへ連絡してください。状況を確認し、再提供、交換又は返金等の合理的な対応を行います。
        </li>
        <li>
          AI処理を実行しなかったことが確認できる失敗については、当該処理のために予約又は消費した利用枠を戻します。外部AI事業者での実行結果が直ちに確定できない場合は、確認が完了するまで利用枠が予約状態となることがあります。利用枠を戻すことは、サブスクリプション料金又は追加クレジット購入代金の返金とは異なります。
        </li>
        <li>
          返金、支払取消し又は異議申立てが成立した場合、対応する商品の利用権又はクレジットを取り消すことがあります。
        </li>
      </ul>

      <h2 className={headingClass}>ソフトウェアの動作環境</h2>
      <ul className={listClass}>
        <li>Windows 10以上（x64）</li>
        <li>macOS 14.0以上</li>
        <li>Ubuntu 22.04</li>
      </ul>
      <p className="leading-7 not-first:mt-6">
        パッケージごとに追加の要件がある場合は、その商品ページ又は同梱文書を確認してください。
      </p>

      <h2 className={headingClass}>その他の条件</h2>
      <p className="leading-7 not-first:mt-6">
        購入、利用枠、公開パッケージ及びAI機能に関するその他の条件は、
        <Link
          className="underline underline-offset-4 hover:text-primary"
          href={`/${lang}/docs/terms`}
        >
          利用規約
        </Link>
        に定めます。
      </p>
    </article>
  );
}
