import type { Metadata } from "next";
import Link from "next/link";
import { EnglishPrivacyPage } from "./english";

type Props = {
  params: Promise<{ lang: string }>;
};

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { lang } = await props.params;
  return lang === "en"
    ? {
        title: "Privacy Policy | Beutl",
        description: "How Beutl handles information about its users.",
      }
    : {
        title: "プライバシーポリシー | Beutl",
        description: "Beutlにおける利用者情報の取扱いを説明します。",
      };
}

const sectionClass =
  "mt-10 scroll-m-20 text-2xl font-semibold tracking-tight";
const subSectionClass =
  "mt-6 scroll-m-20 text-xl font-semibold tracking-tight";
const listClass = "my-6 ml-6 list-disc [&>li]:mt-2";
const orderedListClass = "my-6 ml-6 list-decimal [&>li]:mt-2";
const linkClass = "underline underline-offset-4 hover:text-primary";

export default async function Page(props: Props) {
  const { lang } = await props.params;
  if (lang === "en") return <EnglishPrivacyPage lang={lang} />;

  return <JapanesePrivacyPage lang={lang} />;
}

function JapanesePrivacyPage({ lang }: { lang: string }) {
  return (
    <article className="max-w-5xl mx-auto py-10 lg:py-6 px-4 lg:px-6 bg-card lg:rounded-lg border text-card-foreground lg:my-4">
      <h1 className="scroll-m-20 border-b pb-2 text-3xl font-semibold tracking-tight first:mt-0">
        プライバシーポリシー
      </h1>
      <p className="mt-4 text-sm text-muted-foreground">
        制定日：2024年10月12日　最終改定日：2026年9月6日
      </p>
      <p className="leading-7 not-first:mt-6">
        Beutlの運営者（以下「運営者」といいます。）は、アカウント、ストア、クラウドストレージ、有料AI機能、APIその他のオンラインサービス（以下、総称して「本サービス」といいます。）で取り扱う利用者情報を、次のとおり取り扱います。
      </p>
      <p className="leading-7 not-first:mt-6">
        本ポリシーは、beutl.beditor.net及び同ドメインで提供するAPIその他本サービスに適用されます。外部サイト及び第三者が独自に提供するパッケージ等には、各提供者のポリシーが適用される場合があります。Beutlデスクトップアプリが任意で送信する利用状況データについては、
        <Link className={linkClass} href={`/${lang}/docs/telemetry`}>
          テレメトリーポリシー
        </Link>
        も確認してください。
      </p>

      <h2 className={sectionClass}>1. 取得する情報</h2>

      <h3 className={subSectionClass}>1.1 アカウント及び認証情報</h3>
      <ul className={listClass}>
        <li>氏名又は表示名、メールアドレス、プロフィール画像、利用者ID</li>
        <li>プロフィールの自己紹介、公開用ユーザー名及び登録したソーシャルリンク</li>
        <li>Google又はGitHub等の連携先、外部アカウント識別子、認証トークン及び許可された権限の範囲</li>
        <li>パスキーの公開鍵、認証器の種別、バックアップ状態、作成日時及び最終利用日時</li>
        <li>セッション、デスクトップアプリの認証及び本人確認に必要なトークンと有効期限</li>
      </ul>
      <p className="leading-7 not-first:mt-6">
        本サービスは現在パスワード認証を提供していないため、Beutlアカウント用のパスワードは取得しません。Google又はGitHubのパスワードも運営者には提供されません。
      </p>

      <h3 className={subSectionClass}>1.2 プロフィール、ストレージ及び公開コンテンツ</h3>
      <ul className={listClass}>
        <li>保存又は公開したファイルの内容、ファイル名、種類、容量、ハッシュ値、公開範囲及び作成・更新日時</li>
        <li>パッケージの名称、説明、Webサイト、タグ、価格、通貨、画像、リリース、対応バージョン及び公開状態</li>
        <li>ストアで取得したパッケージ、ライブラリへの追加・削除及びダウンロードに必要な情報</li>
        <li>アップロードの進行状況、再開又は安全な削除に必要な識別子及び処理記録</li>
      </ul>

      <h3 className={subSectionClass}>1.3 AI機能の入力、出力及び利用履歴</h3>
      <ul className={listClass}>
        <li>プロンプト、編集指示、用語集、字幕、言語、スタイル及びその他の設定</li>
        <li>参照画像、編集対象画像、動画の先頭・末尾画像及び文字起こし対象の音声</li>
        <li>生成画像・動画、文字起こし・翻訳結果その他のAI出力</li>
        <li>選択したモデル、処理種別、処理状態、エラー、日時、消費した利用枠、再試行及び重複課金防止に必要な識別情報</li>
      </ul>
      <p className="leading-7 not-first:mt-6">
        画像、音声、字幕等には、利用者又は第三者の顔、声、氏名その他の個人情報が含まれる場合があります。利用者は、必要な権利及び本人同意を得た情報だけを送信してください。
      </p>

      <h3 className={subSectionClass}>1.4 購入、請求及び利用枠に関する情報</h3>
      <ul className={listClass}>
        <li>Stripeの顧客、チェックアウト、支払い、請求書、サブスクリプション、返金及び異議申立てに関する識別子と状態</li>
        <li>購入商品、金額、通貨、課金期間、購入日時、利用権及び支払い履歴</li>
        <li>AIの月間利用量、追加クレジット、返金等に伴う調整及び取引履歴</li>
      </ul>
      <p className="leading-7 not-first:mt-6">
        カード番号、セキュリティコードその他のカード情報はStripeへ直接入力され、運営者は完全なカード情報を保存しません。
      </p>

      <h3 className={subSectionClass}>1.5 問い合わせ及びフィードバック</h3>
      <p className="leading-7 not-first:mt-6">
        氏名、メールアドレス、問い合わせの分類・本文、対応状況及び運営者との連絡内容を取得します。
      </p>

      <h3 className={subSectionClass}>1.6 技術情報及び利用記録</h3>
      <ul className={listClass}>
        <li>IPアドレス、接続元ポート、User-Agent、ブラウザー、OS、端末種別及びおおまかな国・地域</li>
        <li>アクセス日時、要求先、操作内容、参照元、応答状態、障害情報及びセキュリティ監査ログ</li>
        <li>Cookie、セッション識別子及びブラウザーに保存される設定・復旧情報</li>
      </ul>

      <h3 className={subSectionClass}>1.7 外部サービスから受け取る情報</h3>
      <p className="leading-7 not-first:mt-6">
        利用者が選択した場合、Google又はGitHubから氏名、メールアドレス、プロフィール画像、外部アカウント識別子その他認証に必要な情報を、Stripeから支払い及び契約状態を、AI事業者から処理結果及び利用状況を受け取ります。受け取る範囲は、利用者の設定、各サービスの仕様及び許可画面により異なります。
      </p>

      <h2 className={sectionClass}>2. 利用目的</h2>
      <p className="leading-7 not-first:mt-6">
        運営者は、取得した情報を次の目的で利用します。
      </p>
      <ul className={listClass}>
        <li>本人確認、認証、アカウント及びプロフィールの管理</li>
        <li>ファイルの保存、取得、公開、配信、容量管理及び安全な削除</li>
        <li>パッケージの公開、審査、検索、取得、購入、ライブラリ管理及び再配信</li>
        <li>AI処理の実行、結果の保存、履歴表示、利用枠の計算、重複実行の防止及び失敗時の復旧</li>
        <li>決済、請求、定期購入、返金、支払取消し、不正利用防止及び会計処理</li>
        <li>問い合わせへの回答、本人への重要な通知及びサポート</li>
        <li>障害の調査、セキュリティ監視、不正アクセス防止、監査及び権利侵害対応</li>
        <li>本サービスの品質、性能、使いやすさ及び機能の改善</li>
        <li>個人を識別できない形での利用状況、費用及び稼働状況の集計・分析</li>
        <li>本規約その他の条件の履行、紛争対応及び法令上の義務の履行</li>
      </ul>

      <h2 className={sectionClass}>3. 公開される情報</h2>
      <p className="leading-7 not-first:mt-6">
        公開用ユーザー名、表示名、自己紹介、ソーシャルリンク、プロフィール画像、公開パッケージ、その説明、価格、スクリーンショット及びリリースファイル等は、利用者が公開操作を行った場合、インターネット上の不特定多数の者へ提供されます。検索エンジン又は第三者の保存により、公開を停止した後も複製が残る場合があります。秘密情報又は公開してはならない個人情報を含めないでください。
      </p>

      <h2 className={sectionClass}>4. AI機能における情報の取扱い</h2>
      <ol className={orderedListClass}>
        <li>
          AI機能への入力は、処理のためOpenRouter, Inc.へ送信され、さらに選択されたモデルを実行するAI事業者へ送信されます。モデルの提供者と実際の処理基盤が異なる場合があります。
        </li>
        <li>
          OpenRouter及び各AI事業者における入力・出力の保存、学習利用及び安全確認の条件は、選択されたモデル、処理経路及び各社の方針により異なります。本サービスは、すべてのAI処理についてゼロデータ保持又は学習不使用を保証するものではありません。
        </li>
        <li>
          運営者は、処理結果、ジョブ履歴及び課金・復旧に必要な情報を保存します。元の画像又は音声は、利用者が別途ストレージへ保存しない限り、通常はAI処理のため一時的に取り扱い、Beutlのジョブ履歴用ファイルとしては保存しません。ただし、外部AI事業者における保持は各社の条件に従います。
        </li>
        <li>
          機密情報、認証情報、要配慮個人情報、医療・金融情報又は第三者の個人情報は、その送信に正当な権限と必要性がある場合を除き入力しないでください。
        </li>
      </ol>
      <p className="leading-7 not-first:mt-6">
        OpenRouterの最新の取扱いは、
        <a
          className={linkClass}
          href="https://openrouter.ai/privacy"
          target="_blank"
          rel="noreferrer"
        >
          OpenRouter Privacy Policy
        </a>
        及び
        <a
          className={linkClass}
          href="https://openrouter.ai/docs/guides/privacy/provider-logging"
          target="_blank"
          rel="noreferrer"
        >
          Provider Logging
        </a>
        で確認できます。
      </p>

      <h2 className={sectionClass}>5. Cookie及びブラウザー内の保存領域</h2>
      <ol className={orderedListClass}>
        <li>
          本サービスは、サインイン状態の維持、セキュリティ、サイドバーの開閉状態等のため、必要なCookieを使用します。Cookieを無効にすると、サインインその他の機能を利用できない場合があります。
        </li>
        <li>
          ブラウザーのローカルストレージ又はセッションストレージに、AIのプロンプトテンプレート、文字起こしから翻訳への一時的な引継ぎデータ、重複実行を避けるための復旧識別子、アップロード完了の復旧情報等を保存します。これらは原則として端末内に保存され、利用者が機能を実行したときに必要な部分だけが本サービスへ送信されます。
        </li>
        <li>
          ブラウザーの設定からCookie及び保存領域を削除できます。削除すると、未完了のアップロード又はAI処理を自動で復旧できなくなる場合があります。
        </li>
        <li>
          現時点で、広告配信又はサイトを横断する行動追跡を目的とするCookie、広告タグ若しくは解析SDKは、本サービスのWebアプリケーションに組み込んでいません。
        </li>
      </ol>

      <h2 className={sectionClass}>6. 外部事業者への委託・提供</h2>
      <p className="leading-7 not-first:mt-6">
        運営者は、本サービスの提供に必要な範囲で、次の外部事業者に情報の取扱いを委託し、又は利用者の指示に基づいて情報を提供します。各社が独立して取得する情報には、各社のポリシーも適用されます。
      </p>
      <div className="my-6 overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead>
            <tr>
              <th className="border px-3 py-2 text-left">事業者・サービス</th>
              <th className="border px-3 py-2 text-left">目的</th>
              <th className="border px-3 py-2 text-left">主に取り扱う情報</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border px-3 py-2">
                <a
                  className={linkClass}
                  href="https://www.cloudflare.com/privacypolicy/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Cloudflare, Inc.
                </a>
              </td>
              <td className="border px-3 py-2">配信、サーバー実行、キャッシュ、ファイル保存、セキュリティ及び運用監視</td>
              <td className="border px-3 py-2">IPアドレス、HTTP通信、技術ログ、ファイル及び本サービス上のデータ</td>
            </tr>
            <tr>
              <td className="border px-3 py-2">
                <a
                  className={linkClass}
                  href="https://www.cockroachlabs.com/privacy/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Cockroach Labs, Inc.（CockroachDB）
                </a>
                <br />
                データ保存地域：シンガポール
              </td>
              <td className="border px-3 py-2">アカウント、履歴、権利及び処理状態の保存</td>
              <td className="border px-3 py-2">本サービスのデータベースに記録される情報</td>
            </tr>
            <tr>
              <td className="border px-3 py-2">
                <a
                  className={linkClass}
                  href="https://stripe.com/jp/privacy"
                  target="_blank"
                  rel="noreferrer"
                >
                  Stripe, Inc.
                </a>
              </td>
              <td className="border px-3 py-2">決済、定期購入、請求書、返金及び不正利用防止</td>
              <td className="border px-3 py-2">メールアドレス、顧客・取引識別子、購入内容、金額、カード情報及び請求情報</td>
            </tr>
            <tr>
              <td className="border px-3 py-2">
                <a
                  className={linkClass}
                  href="https://policies.google.com/privacy?hl=ja"
                  target="_blank"
                  rel="noreferrer"
                >
                  Google LLC
                </a>
                ・
                <a
                  className={linkClass}
                  href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement"
                  target="_blank"
                  rel="noreferrer"
                >
                  GitHub, Inc.
                </a>
              </td>
              <td className="border px-3 py-2">外部アカウントによる認証、連携情報の表示</td>
              <td className="border px-3 py-2">外部アカウント識別子、氏名、メールアドレス、プロフィール画像、認証トークン及び許可範囲</td>
            </tr>
            <tr>
              <td className="border px-3 py-2">
                <a
                  className={linkClass}
                  href="https://resend.com/legal/privacy-policy"
                  target="_blank"
                  rel="noreferrer"
                >
                  Plus Five Five, Inc.（Resend）
                </a>
              </td>
              <td className="border px-3 py-2">サインインリンク、本人確認及びサービス通知のメール送信</td>
              <td className="border px-3 py-2">メールアドレス、メール本文及び配信情報</td>
            </tr>
            <tr>
              <td className="border px-3 py-2">
                <a
                  className={linkClass}
                  href="https://openrouter.ai/privacy"
                  target="_blank"
                  rel="noreferrer"
                >
                  OpenRouter, Inc.
                </a>
                及び選択モデルのAI事業者
              </td>
              <td className="border px-3 py-2">AI処理、モデルへの経路選択、結果返却及び利用量管理</td>
              <td className="border px-3 py-2">AIへの入力・出力、モデル、処理識別子及び技術的な利用情報</td>
            </tr>
            <tr>
              <td className="border px-3 py-2">
                <a
                  className={linkClass}
                  href="https://ipinfo.io/privacy-policy"
                  target="_blank"
                  rel="noreferrer"
                >
                  IPinfo, Inc.
                </a>
              </td>
              <td className="border px-3 py-2">国に応じた通貨の推測（配信基盤から国情報を得られない場合）</td>
              <td className="border px-3 py-2">IPアドレス</td>
            </tr>
            <tr>
              <td className="border px-3 py-2">
                <a
                  className={linkClass}
                  href="https://grafana.com/legal/privacy-policy/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Raintank, Inc.（Grafana Labs／Grafana Cloud）
                </a>
              </td>
              <td className="border px-3 py-2">任意のデスクトップアプリ・テレメトリー</td>
              <td className="border px-3 py-2">エラーログ、性能、利用状況その他のテレメトリー情報（詳細はテレメトリーポリシーに記載）</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="leading-7 not-first:mt-6">
        Google又はGitHubのプロフィール画像を表示する際、画像の配信元へIPアドレス、User-Agent及び参照情報等が送信される場合があります。また、外部リンクを開いた後の情報はリンク先事業者が取得します。
      </p>
      <p className="leading-7 not-first:mt-6">
        上記のほか、本人の同意がある場合、法令に基づく場合、人の生命・身体・財産の保護に必要で同意取得が困難な場合、又は事業承継に伴う場合等、個人情報保護法その他の法令で認められる範囲で情報を提供することがあります。
      </p>

      <h2 className={sectionClass}>7. 外国における取扱い</h2>
      <p className="leading-7 not-first:mt-6">
        本サービスのデータベースに記録される情報は、CockroachDBのシンガポールリージョンに保存します。Cockroach Labs, Inc.は米国に所在し、サービスの運用又はサポート等のため、同社又は再委託先がシンガポール国外から情報を取り扱う場合があります。
      </p>
      <p className="leading-7 not-first:mt-6">
        その他の委託先の多くも米国に所在し、そのサーバー又は再委託先は日本、シンガポール、米国、欧州その他の国・地域に所在する場合があります。AI処理の国は、利用者が選択したモデル、OpenRouterの処理経路、稼働状況及びモデル提供者の再委託先により変わるため、あらかじめ一つの国へ特定できません。候補となる事業者及び所在国は、
        <a
          className={linkClass}
          href="https://openrouter.ai/providers"
          target="_blank"
          rel="noreferrer"
        >
          OpenRouterのProvider一覧
        </a>
        で確認できます。
      </p>
      <p className="leading-7 not-first:mt-6">
        運営者は、各事業者の公表情報及び契約条件を確認し、送信する情報の限定、通信の暗号化、アクセス制御その他の安全管理措置を講じます。具体的な取扱国又は安全管理措置について確認したい場合は、連絡先へ問い合わせてください。
      </p>

      <h2 className={sectionClass}>8. 保存期間と削除</h2>
      <ul className={listClass}>
        <li>
          アカウント、プロフィール、ストレージ及び公開コンテンツは、利用者が削除するか、アカウントが終了するまでを基本として保存します。
        </li>
        <li>
          Webのサインインセッションは、原則として最終更新から最大30日間有効です。サインアウト、失効又はセキュリティ上の必要により、それより前に無効化することがあります。
        </li>
        <li>
          文字起こし及び字幕翻訳の結果ファイルは原則として作成から30日後に削除します。生成画像及び動画は、利用者がジョブ若しくはファイルを削除するか、アカウントが終了するまでを基本として保存します。ジョブの識別子、状態、入力設定及び利用量の記録は、課金、履歴、復旧及び不正防止に必要な期間保存します。
        </li>
        <li>
          完了しなかったファイルアップロードは、原則として24時間経過後に削除処理の対象とします。障害又は外部ストレージの応答が不確かな場合は、安全に削除できることが確認されるまで復旧記録を保持することがあります。
        </li>
        <li>
          取引、請求、返金、監査及びセキュリティに関する記録は、法令上の保存義務、会計、紛争解決、不正防止及び権利保護に必要な期間保存します。
        </li>
        <li>
          ブラウザー内のプロンプトライブラリ等は、利用者が削除するかブラウザーの保存領域を消去するまで端末に残ります。AIの処理復旧情報は原則として30日で失効します。
        </li>
        <li>
          削除を受け付けた情報も、バックアップの上書き、外部事業者での削除又は進行中の決済・返金・ストレージ処理が完了するまで、隔離又は利用を制限した状態で一定期間残る場合があります。
        </li>
      </ul>

      <h2 className={sectionClass}>9. 安全管理措置</h2>
      <p className="leading-7 not-first:mt-6">
        運営者は、取り扱う情報の性質及びリスクに応じて、主に次の措置を講じます。安全を損なわない範囲で、本人からの求めに応じて詳細を回答します。
      </p>
      <ul className={listClass}>
        <li>管理者権限と利用者権限の分離、本人ごとのアクセス制御及び認証</li>
        <li>通信の暗号化、トークン等の適切なハッシュ化又は秘密情報としての管理</li>
        <li>非公開ファイルへの認可確認、推測困難な保存識別子及びアップロード容量の制限</li>
        <li>重要操作の監査記録、異常及び障害の記録、再試行や重複処理を安全に行うための制御</li>
        <li>個人データへアクセスできる者の限定及び外部委託先の取扱条件の確認</li>
        <li>漏えい等が発生した場合の調査、影響拡大の防止、復旧及び法令に基づく報告・本人通知</li>
      </ul>

      <h2 className={sectionClass}>10. 本人による確認、訂正及び削除</h2>
      <ol className={orderedListClass}>
        <li>
          利用者は、アカウント設定からプロフィール、メールアドレス、連携アカウント、パスキー、ファイル、AIジョブ等を確認、変更又は削除できます。アカウント自体の削除も同画面から申請できます。
        </li>
        <li>
          利用目的の通知、保有個人データ又は第三者提供記録の開示、訂正・追加・削除、利用停止・消去又は第三者提供の停止を希望する場合は、登録メールアドレス、希望する手続及び対象情報をcontact@beditor.netへ送ってください。
        </li>
        <li>
          運営者は、アカウントへのサインイン確認、登録メールアドレスへの返信その他合理的な方法で本人又は正当な代理人であることを確認し、法令に従って遅滞なく回答します。法令上応じられない場合は、その理由を説明します。
        </li>
        <li>
          アカウント削除前に、必要なファイル及びAI結果を利用者自身で保存してください。削除後は再取得できない場合があります。
        </li>
      </ol>

      <h2 className={sectionClass}>11. 個人情報の販売及び匿名情報</h2>
      <p className="leading-7 not-first:mt-6">
        運営者は、個人情報を対価と引き換えに販売しません。また、広告配信のために個人情報を第三者へ提供しません。個人を識別できないよう集計又は匿名化した統計情報は、サービスの運営、改善、費用管理又は情報公開のために利用することがあります。
      </p>

      <h2 className={sectionClass}>12. 未成年者</h2>
      <p className="leading-7 not-first:mt-6">
        未成年者は、親権者その他の法定代理人の同意を得たうえで本サービスを利用してください。法定代理人の同意なく個人情報が提供されたことが判明した場合は、連絡先へ知らせてください。本人確認のうえ、法令に従って対応します。
      </p>

      <h2 className={sectionClass}>13. 本ポリシーの変更</h2>
      <p className="leading-7 not-first:mt-6">
        運営者は、サービス内容又は法令の変更等に応じて本ポリシーを変更することがあります。変更内容と効力発生日を本ページに掲載し、利用者への影響が大きい変更は、合理的な期間を設けて本サービス上又は登録メールアドレスへの通知等により知らせます。法令上本人の同意が必要な変更は、所定の方法で同意を得ます。
      </p>

      <h2 className={sectionClass}>14. 問い合わせ及び苦情窓口</h2>
      <p className="leading-7 not-first:mt-6">
        個人情報の取扱い、本ポリシー、安全管理措置又は開示等の請求に関する問い合わせ及び苦情は、次の窓口へ連絡してください。
      </p>
      <p className="leading-7 not-first:mt-6">
        運営者・個人情報保護窓口：Beutl運営者
        <br />
        メールアドレス：contact@beditor.net
      </p>
    </article>
  );
}
