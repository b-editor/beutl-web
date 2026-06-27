# beutl-web リファクタリング計画

> 本計画は、コードベース全体を12の観点(API世代/認証/データアクセス/コンポーネント/サーバーアクション/i18n/デッドコード・依存/設定ビルド/型安全/DBスキーマ/ルーティング/スタイリング)から並列に監査し、
検出した **112件** の発見を敵対的検証(死蔵コードの未参照確認・外部デスクトップアプリのAPI契約への影響確認)にかけたうえで、依存関係とリスクでフェーズ順に並べたものです。検証で却下された発見は 0 件。

## エグゼクティブサマリ

beutl-web は Next.js 15 / Cloudflare Workers (@opennextjs/cloudflare) / Prisma / better-auth / Stripe / Hono で構成された、Beutl デスクトップアプリ向けマーケットプレイスである。コードベース自体は小規模で多くの部分は健全だが、3 つの大きな歪みが蓄積している。(1) デプロイ・lint・DB プロバイダの「設定の三重化」(Cloudflare 実体に対し Vercel CI と SSH-systemctl が残存、ESLint と未起動の Biome が共存、schema は cockroachdb 宣言だが実行は adapter-pg)。(2) データアクセス層が src/lib/db/* の関数層・packages-db.ts/store-utils.ts の並行ヘルパ・約28ファイルの直接 getDbAsync() 呼び出しに三分裂し、パッケージ読み出しマッパーが5〜6箇所に複製されている。(3) NextAuth→better-auth および Prisma→Drizzle revert の移行残骸(死んだ UI プリミティブ、ワンオフ移行スクリプト、孤立した i18n キー、zod: 名前空間の遺物)。加えて、デスクトップアプリが消費する v1/v2/v3 API と native-auth フローという外部契約が存在するため、これに触れる変更は厳格な互換戦略の下で後送りする。本リファクタリングの方針は「外部契約を不変に保ちつつ、まずゼロリスクの設定・死コード掃除で表面積を縮小し、次にデータアクセス層を統一する基盤を整え、その上で内部の重複・型・i18n・エラーハンドリングを段階的に正す」ことである。

## 全体方針(各フェーズに共通する原則)

- 外部契約の不変性を最優先する: デスクトップアプリが消費する v1/v2/v3 API の JSON バイト列、native-auth フロー、JWT クレーム名・refresh-token 暗号化形式、Stripe webhook の応答コードは、明示的な互換戦略とテレメトリ確認なしに変更しない。
- 1 PR は 1 種類の変更に限定する: 死コード削除・重複統合・型変更・i18n 修正・設定変更を混在させない。各 work item は独立してシップ可能・レビュー可能・revert 可能であること。
- 削除より先に統合の受け皿を作る: 死コードを消してから残りをリファクタする。データアクセスの統一関数を先に用意してから直接呼び出しを移行する。マッパー統合の前に出力 DTO のバイト等価性を現行の emit 形状を基準に固定する。
- クライアントテレメトリで撤去を gate する: v1/checkForUpdates, v2/identity/signInWith, /account/signIn, dead v1 handler 等の外部到達可能な経路は、最古サポート対象デスクトップビルドが呼ばないことを確認するまで削除せず、deprecated コメントのみ付与する。
- プロバイダ・エンジンの真実源を一本化する: DB エンジン(**CockroachDB**。オーナー確認済み、schema は cockroachdb のまま)、デプロイ先(Cloudflare)、lint ツール(1つ)をそれぞれ単一の宣言に揃え、矛盾する設定を除去する。
- 外部 API の応答 DTO を変更する統合は、変更前に現行の emit 形状(paid/bio null vs undefined/logoId など)を基準にゴールデン値として固定し、リファクタ後にバイト等価を検証する。
- TypeScript の型システムを活用する: 統合・型注釈の変更はコンパイル時に呼び出し側で破綻が検出される範囲で行い、ランタイム挙動を変えない。

## Quick Wins(Phase 0 で即着手できる低リスク高価値項目)

- v3/app.ts:78 の await 漏れ修正(404 ボディが {} になりデスクトップのエラー受信を壊している latent バグ。1 行修正)
- moveScreenshot の getPackageNameFromPackageId await 漏れ修正(画面並べ替え後の revalidate が /[object Promise] になる。1 行修正)
- currency.ts の本番 PII(IP/country)console.log 3 行削除(GDPR 関連、ログ汚染)
- 未使用 shadcn プリミティブ 3 ファイル(ui/drawer, ui/form, ui/tabs)と死依存 4 つ(vaul, react-hook-form, @hookform/resolvers, @radix-ui/react-tabs)の削除
- 死コード lib/api/types.ts(paied typo 含む 6 DTO)の削除
- ローカル .vercel/ アーティファクト削除(stale な S3 鍵を含む)と未完成 ci.yml(Vercel プレースホルダ)の削除
- 壊れた i18n キーの修正(ja signOut case ドリフト、account cancelAccountDeletion typo、en account body の日本語固定、auth:errors.magicLink/oauth 欠落)
- ワンオフ better-auth 移行スクリプト 3 本の削除/アーカイブ(再実行不能な debris)
- 未参照アセット(Geist フォント, fluid.module.css, スキャフォールド画像)と空ディレクトリの削除
- died LanguageProvider コンテキスト(消費者ゼロ)の削除

## フェーズ一覧

| # | フェーズ | リスク | 目安工数 | 項目数 |
|---|---------|:----:|---------|:----:|
| 0 | ゼロリスクの即時掃除 (死コード・死アセット・死設定の除去) | 低 | 1-2 days | 8 |
| 1 | 設定・ツールチェーンの真実源を一本化 | 中 | 3-4 days | 5 |
| 2 | 外部 API 内部の安全な修正と重複除去 | 中 | 1-2 days | 6 |
| 3 | データアクセス層の統一基盤を構築 | 高 | 1-1.5 weeks | 5 |
| 4 | データアクセス境界の強制と直接呼び出しの移行 | 中 | 1 week | 2 |
| 5 | サーバーアクション層の構造化と内部一貫性 | 中 | 1-1.5 weeks | 6 |
| 6 | i18n の修正・整備とコンポーネント重複の統合 | 低 | 1-1.5 weeks | 5 |
| 7 | ルーティング/レイアウト整理とエラーハンドリング堅牢化 | 中 | 1-1.5 weeks | 6 |
| 8 | 外部契約の撤去 (テレメトリ gate 付き・最終フェーズ) | 高 | 1-2 weeks (テレメトリ待ち含むため期間は前後する) | 4 |

---

## Phase 0: ゼロリスクの即時掃除 (死コード・死アセット・死設定の除去)

**リスク**: 低 ／ **目安工数**: 1-2 days

**ゴール**: インバウンド参照ゼロの死ファイル・死依存・死アセット・死設定を削除し、後続フェーズが対象とする表面積を即座に縮小する。外部契約・ランタイム挙動には一切触れない。

**この順序である理由**: 全項目が「参照ゼロ/到達不能」を二重に検証済みで、削除がコンパイル・ランタイム・外部 API に影響しないことが確認されている。最初に表面積を縮めることで以降のレビューが容易になる。依存は他フェーズへ前向きにのみ作用する。

**作業項目**:

1. **[S/低]** 未使用 shadcn UI プリミティブ 3 ファイルを削除し、それぞれが唯一の利用元である npm 依存も除去する: ui/drawer.tsx と vaul、ui/form.tsx と react-hook-form + @hookform/resolvers、ui/tabs.tsx と @radix-ui/react-tabs。削除後に lockfile を再生成する。
   - 対象: `src/components/ui/{drawer,form,tabs}.tsx, package.json, pnpm-lock.yaml`
   - 根拠ID: unused-vaul-drawer,dead-ui-drawer-tsx,unused-ui-form,dead-ui-form-tsx,unused-ui-tabs,dead-ui-tabs-tsx
2. **[S/低]** 死コードの lib/api/types.ts (6 つの未参照レスポンス DTO、paied typo を含む) を削除する。後でワイヤ契約の型付けが必要になればマッパーから再生成する。
   - 対象: `src/lib/api/types.ts`
   - 根拠ID: dead-api-types-file,dead-lib-api-types
3. **[S/低]** 未参照の CSS モジュール fluid.module.css、未インポートの Geist フォント 2 ファイル、参照ゼロの public/img アセット(まず明確なスキャフォールド残骸 icon-placeholder.png, logo.svg, github.svg, logo_dark_2.png を削除。brand-image.png/logo_dark.png は外部ホットリンクの可能性があるため別途確認後)を削除する。
   - 対象: `src/styles/fluid.module.css, src/app/fonts/, public/img/`
   - 根拠ID: unused-fluid-css-module,dead-fluid-css-module,fluid-module-unused,dead-geist-fonts,unused-public-images
4. **[S/低]** 空ディレクトリ(src/components/effects-demo/, src/components/security/, developer/earnings/, developer/settings/)とローカルの .vercel/ アーティファクトを削除する。.vercel/.env.development.local の S3 鍵が本番で生きていればローテーションする。
   - 対象: `src/components/effects-demo/, src/components/security/, src/app/[lang]/(developer)/developer/{earnings,settings}/, .vercel/`
   - 根拠ID: empty-effects-demo-dir,empty-untracked-component-dirs,empty-developer-route-dirs,stale-vercel-dir
5. **[S/低]** died された better-auth 移行スクリプト 3 本(migrate-auth-data.ts, convert-credential-id-base64url.ts, delete-passkey-accounts.ts)を削除または docs/migrations/ アーカイブへ退避する。better-auth 稼働済みのため再実行不能。
   - 対象: `scripts/migrate-auth-data.ts, scripts/convert-credential-id-base64url.ts, scripts/delete-passkey-accounts.ts`
   - 根拠ID: oneoff-migration-scripts
6. **[S/低]** died された lib/db/passkey.ts の updatePasskeyUsedAt と findPasskeyByCredentialId を削除する(better-auth passkey プラグインが内部処理)。他 3 関数は残す。
   - 対象: `src/lib/db/passkey.ts`
   - 根拠ID: dead-passkey-fns
7. **[S/低]** globals.css のコメントアウト済み重複テーマブロック、死んだ light-mode 関連の検討、未使用 @utility(text-balance, glow-primary, glass)、未使用 chart-* トークン、孤立 .shimmer セレクタを除去する。dark 固定なので light-mode パレットの扱いは globals-commented-theme-block 整理後に判断。
   - 対象: `src/app/globals.css, src/styles/hero-gradient.module.css`
   - 根拠ID: globals-commented-theme-block,unused-custom-utilities,unused-chart-color-tokens,orphan-shimmer-class,dead-light-mode-palette
8. **[S/低]** died された LanguageProvider/useLanguage/setLanguage コンテキストと layout.tsx のマウントを削除する(全消費者ゼロ、lang は URL から取得)。{children} と <Toaster /> のレンダリングは維持する。
   - 対象: `src/app/i18n/client.tsx, src/app/[lang]/layout.tsx`
   - 根拠ID: dead-language-context

**完了条件(Exit Criteria)**: pnpm build と pnpm lint が成功し、削除した依存が package.json/lockfile から消え、git diff が純粋な削除のみであること。v1/v2/v3 API レスポンスと native-auth フローのスモークテストが従来どおりであること。

---

## Phase 1: 設定・ツールチェーンの真実源を一本化

**リスク**: 中 ／ **目安工数**: 3-4 days

**ゴール**: デプロイ・lint・DB プロバイダ・Node バージョン・env ドキュメントの矛盾を解消し、リポジトリから「このアプリが実際どうビルド・デプロイされるか」が一意に読めるようにする。

**この順序である理由**: 設定の歪みは他フェーズの作業環境そのものに影響する(誤った lint/型生成/移行 DDL ターゲット)。ランタイムコードにほぼ触れないため早期に安全に確定でき、DB プロバイダ整合は後続の index 追加・migration 再生成の前提となる。

**作業項目**:

1. **[M/低]** Cloudflare を単一デプロイ先に確定する。未完成テンプレートの .github/workflows/ci.yml(Vercel CLI、stg.my-service.com プレースホルダ)を削除し、pnpm deploy(opennextjs-cloudflare)を実行する単一ワークフローに置換する。self-hosted systemctl の deploy.yml はオーナー確認後に削除(next.config に standalone 出力がなく現状機能不全)。
   - 対象: `.github/workflows/ci.yml, .github/workflows/deploy.yml`
   - 根拠ID: triple-deploy-targets
2. **[M/低]** lint ツールを 1 つに統一する。未起動かつ v1 スキーマで設定された Biome を除去(@biomejs/biome 依存削除、biome.json 削除、ソース中の biome-ignore コメント 10 箇所を整理)し、ESLint に一本化する。.eslintrc.json は唯一の ESLint 設定なので削除せず維持する。
   - 対象: `package.json, biome.json, src/app/[lang]/(developer)/developer/projects/[name]/actions.ts, src/hooks/use-toast.ts ほか`
   - 根拠ID: biome-unused-and-misconfigured,recon-correction-no-flat-eslint
3. **[訂正済み・対応不要]** ~~DB プロバイダを postgresql に揃える~~ → **オーナー確認の結果、実エンジンは CockroachDB と判明（2026-06-23）。schema.prisma datasource と migration_lock.toml はすでに `cockroachdb` 宣言で正しく、変更不要。** `@prisma/adapter-pg` と better-auth の `provider: "postgresql"` 設定は、CockroachDB が pg ワイヤ互換のため動作しているだけで矛盾ではない。以降の全 Prisma マイグレーション（Phase 7 のインデックス追加含む）は **cockroachdb 前提**で生成すること。当初プランの postgresql 切替推奨は誤りとして取り下げ。
   - 対象: `prisma/schema.prisma, prisma/migrations/migration_lock.toml`（変更なし）
   - 根拠ID: provider-mismatch-cockroach-vs-postgres（解決: CockroachDB で確定）
4. **[S/低]** .env.sample を実使用に同期する。コードが読む 11 個の未文書化キー(AUTH_RESEND_KEY, AUTH_SECRET, JWT_* 群, BEUTL_*_VERSION, METADATA_BASE_URL 等)を追加し、未使用の EMAIL_SERVER_* と DATABASE_HOST/NAME/USER/PASSWORD を削除する。DATABASE_URL は build-only として残し注記する。
   - 対象: `.env.sample`
   - 根拠ID: env-sample-drift
5. **[S/低]** Node バージョンを単一の真実源に揃える。package.json に engines.node を追加し、CI の setup-node を .nvmrc 読み取りに、devcontainer イメージを同一メジャーに更新する。cf-typegen の出力ファイル名を実在の worker-configuration.d.ts と一致させる(または生成へ移行)。README をボイラープレートから実態(Beutl マーケットプレイス、Cloudflare デプロイ)へ書き換える。next lint への依存は ESLint 直接呼び出しへの移行を検討。public/_headers が Workers/OpenNext で honor されるか確認する。
   - 対象: `package.json, .nvmrc, .devcontainer/devcontainer.json, .github/workflows/, README.md, public/_headers`
   - 根拠ID: node-version-drift,cf-typegen-output-mismatch,boilerplate-readme,next-lint-deprecation,headers-file-platform-mismatch

**完了条件(Exit Criteria)**: 単一の Cloudflare デプロイワークフローが存在し他は削除済み、lint コマンドが 1 つに統一され pnpm lint が成功、schema/migration_lock/better-auth の provider が一致、.env.sample がコードの process.env 使用と一致、Node バージョンが全宣言箇所で一致すること。

---

## Phase 2: 外部 API 内部の安全な修正と重複除去

**リスク**: 中 ／ **目安工数**: 1-2 days

**ゴール**: デスクトップアプリ向け API のワイヤ契約を変えずに、内部実装の明白なバグ・重複を修正する。バイト列が変わらない範囲に限定する。

**この順序である理由**: API ルートツリー自体は外部契約として温存しつつ、内部の onError ハンドラ・JWT 抽出・型エクスポート・await 漏れバグは契約に影響しないため安全に整理できる。これらは後続のマッパー統合(フェーズ3)の前提となる足場を整える。

**作業項目**:

1. **[S/低]** v3/app.ts:78 の await 漏れを修正する。apiErrorResponse を await せず c.json に渡しているため 404 ボディが {} になりデスクトップクライアントの構造化エラー受信を壊している。await を追加して他の全呼び出し側と同形にする。
   - 対象: `src/app/api/v3/[[...route]]/app.ts`
   - 根拠ID: missing-await-error-response,missing-await-apierror-v3-app
2. **[S/低]** v1/v3 route.ts に複製された同一の onError ハンドラを lib/api/error.ts の共有 apiOnErrorHandler に抽出し両ツリーから参照する。デスクトップ向けエラーエンベロープを一元化する(挙動不変)。
   - 対象: `src/app/api/v1/[[...route]]/route.ts, src/app/api/v3/[[...route]]/route.ts, src/lib/api/error.ts`
   - 根拠ID: duplicated-onerror-handler
3. **[S/低]** lib/api/auth.ts の getUserId と getUserIdFromHeaders を共通コア verifyBearer(authHeader) に集約する。decode-only の getUserIdFromToken は意図的に分離維持し『認可に使わない』旨コメントする。
   - 対象: `src/lib/api/auth.ts`
   - 根拠ID: duplicated-jwt-extraction-auth
4. **[S/低]** 消費者の存在しない hono/client 用 AppType 型エクスポートを v1/v3 route.ts から削除する(型推論コスト削減、ランタイム影響なし)。
   - 対象: `src/app/api/v1/[[...route]]/route.ts, src/app/api/v3/[[...route]]/route.ts`
   - 根拠ID: dead-apptype-exports
5. **[S/中]** errorCodes の死んだ数値値を整理する。error_code は文字列キーが emit され数値は一切読まれないため、ワイヤ形状を変えずに string-literal union / string enum へ変換し誤解を招く数値プロトコル示唆を除去する。
   - 対象: `src/lib/api/error.ts`
   - 根拠ID: errorcodes-numeric-values-dead
6. **[S/中]** api-errors の i18n キー欠落を補う。実際に返される unknown と invalidVersionFormat を en+ja api-errors.json に追加(現状は生キーがデスクトップに漏れる)。孤立キー disallowedContentType/disposableEmailAddressesAreNotAccepted は error code 化するか削除する。error_code 自体は安定機械コードなので応答 shape は不変。
   - 対象: `src/app/i18n/locales/{en,ja}/api-errors.json, src/lib/api/error.ts`
   - 根拠ID: api-errors-code-key-drift,orphan-api-error-keys

**完了条件(Exit Criteria)**: v3 update エンドポイントの asset-not-found が構造化 404 を返す、onError と Bearer 検証が単一実装、AppType エクスポートが消滅、api-errors の全 emit コードに locale エントリが存在すること。v3 API のレスポンスをゴールデン値と突き合わせバイト等価を確認する。

---

## Phase 3: データアクセス層の統一基盤を構築

**リスク**: 高 ／ **目安工数**: 1-1.5 weeks

**ゴール**: src/lib/db/* の関数層を単一の正規データアクセス面とし、パッケージ読み出しの 5〜6 重マッパーを統合し、欠落テーブルの db 関数を追加し、customer の二重モジュールを解消する。後続の直接呼び出し移行の受け皿を作る。

**この順序である理由**: これが本リファクタの中核基盤。直接呼び出しの一掃(フェーズ4)は統合済み関数が存在して初めて安全に行えるため、それより先に受け皿を用意する。マッパー統合は v3 の外部 JSON を再生産するため、現行 emit 形状を基準にバイト等価で行う。

**作業項目**:

1. **[L/高]** パッケージ読み出しを 1 つのモジュール(src/lib/db/package.ts 拡張)に統合する。共有ベース selector + published フラグ + currency + userId をパラメータ化し、価格 triple-fallback と owner ブロックと getContentUrl ロジックを一元化する。discover.ts mapPackage、library.ts createResponse、packages-db.ts mapPackage、store-utils.ts の query/no-query 2 分岐を統一関数へ向ける。userId/iconFileId フィールドは discover.ts が依存するため正規型に必ず残す。
   - 対象: `src/lib/db/package.ts, src/lib/api/packages-db.ts, src/lib/store-utils.ts, src/app/api/v3/[[...route]]/{discover,library,packages,users}.ts, src/app/[lang]/(store)/library/actions.ts, src/app/[lang]/(store)/publishers/[name]/actions.ts`
   - 根拠ID: package-read-three-layers,three-package-mappers,listed-package-mapper-duplication,retrievepackages-name-collision
2. **[M/低]** getContentUrl を db/file.ts(DB アクセスを行わない)から非 DB ヘルパ(lib/content-url.ts)へ移し、absolute/relative フラグを受け取る形にする。v3 は absolute、Web 同一オリジンは relative という現行の意図的差異を各呼び出し側で厳密に保持しつつ inline の /api/contents/${id} リテラルを置換する。
   - 対象: `src/lib/db/file.ts, src/lib/content-url.ts(新規), store-utils.ts ほか約12箇所`
   - 根拠ID: getcontenturl-two-styles
3. **[L/中]** 欠落テーブルの db 関数層を追加する。db/user-package.ts(library 所有 add/remove/exists)、db/release.ts(create/update/delete/publish/findByPackage)、db/profile.ts(read/update)を既存の prisma? パラメータ規約に従って新設する。inline の select/where/order を保持し v3 JSON 応答のフィールドを落とさない。
   - 対象: `src/lib/db/user-package.ts, src/lib/db/release.ts, src/lib/db/profile.ts(新規)`
   - 根拠ID: tables-with-no-db-layer
4. **[S/低]** customer データアクセスを統合する。lib/customer.ts の createOrRetrieveCustomerId を db/customer.ts へ移し prisma?: PrismaTransaction 署名を付与、lib/customer.ts を削除し唯一の import(checkout/page.tsx)を更新する。webhook の stripeId→userId 逆引きは別操作なので別ヘルパとして切り出すか本作業の範囲外とする。
   - 対象: `src/lib/customer.ts, src/lib/db/customer.ts, src/app/[lang]/(store)/store/[name]/checkout/page.tsx`
   - 根拠ID: two-customer-modules,transaction-param-inconsistency
5. **[M/中]** トランザクション署名を統一する。upsertPackagePricings と統合後の customer 関数に prisma?: PrismaTransaction を追加し、外部 tx 未供給時のみ内部 $transaction を開く形に揃える。PrismaClient の per-call 生成をやめ、まず sync getDb() を削除して async getDbAsync() に一本化する(memoization は別途慎重に)。
   - 対象: `src/lib/db/package.ts, src/lib/db/customer.ts, src/prisma.ts, 4つの sync getDb 利用ページ`
   - 根拠ID: transaction-param-inconsistency,prisma-client-per-call

**完了条件(Exit Criteria)**: パッケージ読み出しマッパーが単一実装、user-package/release/profile の db 関数が存在、lib/customer.ts が削除され import 更新済み、sync getDb が消滅。v3 の packages/users/discover/library 応答が現行ゴールデン値とバイト等価であること。

---

## Phase 4: データアクセス境界の強制と直接呼び出しの移行

**リスク**: 中 ／ **目安工数**: 1 week

**ゴール**: 残る約28ファイルの inline Prisma クエリをフェーズ3で用意した db 関数へ移行し、lint 境界で src/lib/db 外からの @/prisma 直接アクセスを禁止する。

**この順序である理由**: フェーズ3で統合関数が揃って初めて安全に実施できる。テーブル単位で漸進的に移行することでリスクを抑える。better-auth.ts は @/prisma を正当に使うため lint 例外とする。

**作業項目**:

1. **[XL/中]** テーブル単位で inline クエリを db 関数へ漸進移行する。developer/projects/[name]/actions.ts の release 直接呼び出し、v3 packages.ts の db.package/db.release 直接呼び出し等、@/lib/db/* import と独自 getDbAsync() を併用する14ファイルを段階的に統一する。各 select 形状を厳密に保持し v3 応答契約を維持する。
   - 対象: `約28ファイル(developer actions, v3 routes, stripe webhook, store actions, billing/personal-data ページ ほか)`
   - 根拠ID: split-direct-vs-dblayer
2. **[S/低]** no-restricted-imports の ESLint ルールを追加し src/lib/db と src/lib/better-auth.ts 以外からの @/prisma import を禁止する。ルート/アクション/ページが独自 PrismaClient を開けないようにする。better-auth.ts はカーブアウトする。
   - 対象: `.eslintrc.json, src/lib/better-auth.ts`
   - 根拠ID: split-direct-vs-dblayer,tables-with-no-db-layer

**完了条件(Exit Criteria)**: src/lib/db と better-auth.ts 以外に @/prisma の import が存在せず lint で強制される。全 v3 API 応答がゴールデン値とバイト等価で、Stripe webhook・billing・personal-data の各フローがリグレッションなく動作すること。

---

## Phase 5: サーバーアクション層の構造化と内部一貫性

**リスク**: 中 ／ **目安工数**: 1-1.5 weeks

**ゴール**: 認証+revalidate+audit のボイラープレート、検証 preamble、エラー応答形状を共有抽象に集約し、潜在バグと型侵食を解消する。巨大ファイルを凝集モジュールへ分割する。

**この順序である理由**: これらは Web UI 内部のみで消費されデスクトップ API に触れないため外部リスクが低い。フェーズ3/4 でデータ層が整理された後に行うことで、アクションが呼ぶ db 関数が安定している。moveScreenshot の await 漏れバグは共有 revalidate ヘルパで再発防止できる。

**作業項目**:

1. **[S/低]** moveScreenshot の await 漏れバグを修正する。getPackageNameFromPackageId が await されず Promise が revalidatePath に補間され /[object Promise] になっている。await を追加し、画面並べ替え後の project ページ revalidate を正す。
   - 対象: `src/app/[lang]/(developer)/developer/projects/[name]/actions.ts`
   - 根拠ID: move-screenshot-missing-await,move-screenshot-missing-await
2. **[L/中]** 共有アクションヘルパ(formAction/mutation)を導入する。authenticated ラップ・lang 解決・audit ログ・revalidate を 1 呼び出しに集約し、redirect/任意ペイロード/State の異種返却に対応させる。約35箇所の getLanguage()→revalidatePath エピローグと23箇所の authenticated ラッパーを集約する。
   - 対象: `src/lib/(新規 action ヘルパ), 約20の actions.ts`
   - 根拠ID: auth-revalidate-boilerplate
3. **[M/低]** アクション返却型を統一する。共有判別共用体 ActionResult<T> = { success:true; data?:T } | { success:false; message?; errors? } を定義し、deletePasskey の {error?} 形状を変換、updateRelease/createRelease に型注釈を付け release-form.tsx の 3 箇所の as any を除去する。auth-guard.ts 内 2 ファイルの local type Response(DOM Response を shadow)を ActionResult にリネームする。throw 系は middleware で守られた read-only loader 専用と文書化する。
   - 対象: `src/lib/auth-guard.ts, security/actions.ts, developer/projects/[name]/actions.ts, storage/actions.ts, release-form.tsx ほか`
   - 根拠ID: inconsistent-error-response-shapes,action-return-types-untyped-as-any,response-type-shadows-dom,action-result-shape-inconsistency,auth-guard-inconsistent-throw-vs-return
4. **[L/中]** developer/projects/[name]/actions.ts(793 LOC)を package-meta / screenshot / release / pricing-interval の凝集モジュールへ分割し、release 直接 Prisma を db/release.ts(フェーズ3)へ移す。sameUser 所有チェックを共有 owned-package ラッパーへ畳み込み、update ヘルパが name を返すよう変えて getPackageNameFromPackageId の余分な往復を削減する。import パスを約8消費 .tsx で更新(または barrel 再エクスポート)。
   - 対象: `src/app/[lang]/(developer)/developer/projects/[name]/actions.ts + 消費 .tsx`
   - 根拠ID: oversized-developer-projects-file
5. **[M/低]** updatePricing/updateInterval の zod アクセサ誤用を修正する。validated.error.message(常に非 null の JSON blob)を死んだ ?? フォールバックごとローカライズ済み文字列に置換する(Response 型に errors フィールドが無いため fieldErrors は不適)。検証 preamble の parseForm(schema, formData) ヘルパを導入し JP ハードコード文字列を t() に統一、zod スキーマ定義スタイルを (z: Zod) => 形式に標準化する。
   - 対象: `developer/projects/[name]/actions.ts, new/project/actions.ts ほか9アクション`
   - 根拠ID: zod-error-message-wrong-accessor,validation-preamble-duplication
6. **[M/低]** confirmation-token の sendEmail とトークン生成/検証の重複を解消する。createConfirmationToken/consumeConfirmationToken と sendConfirmationEmail を lib に抽出し、死んだ ?? ONE_DAY_IN_SECONDS フォールバックを削除する。consume は redirect/throw を埋め込まず結果を返し、email(redirect)と personal-data(throw)の制御フロー差異を呼び出し側で解釈させる。
   - 対象: `email/actions.ts, personal-data/actions.ts, personal-data/handle/actions.ts`
   - 根拠ID: confirmation-token-email-flow-duplication

**完了条件(Exit Criteria)**: moveScreenshot が正しい project ページを revalidate、共有アクションヘルパと ActionResult が全 mutating アクションで使用、developer projects ファイルが凝集モジュールへ分割、zod エラーが生 JSON を露出しないこと。Web UI の各フォームフローがリグレッションなく動作すること。

---

## Phase 6: i18n の修正・整備とコンポーネント重複の統合

**リスク**: 低 ／ **目安工数**: 1-1.5 weeks

**ゴール**: ランタイムで壊れている翻訳キー・ハードコード文字列・孤立キー・ファントム名前空間を正し、UI/レイアウトの重複(social links, auth-flow chrome, navbar レイアウト)を統合する。

**この順序である理由**: i18n とコンポーネント整備は Web UI 表示のみに影響し外部 API に触れないため低リスク。developer ポータルの i18n 化はサーバーアクション分割(フェーズ5)後の方が触る面が安定している。

**作業項目**:

1. **[M/低]** ランタイムで壊れている i18n キーを修正する: auth の case ドリフト(ja signout→signOut)、account:data.cancelAccountDeletion typo(canceledAccountDeletion へ)、en account の confirmationAccountDeletion.body が日本語固定(英訳、{{url}} と <a> マークアップは保持)、auth:errors.magicLink/oauth の欠落キー追加、zod: 名前空間の遺物 4 呼び出しを zod のローカライズ済み validated.error.issues[].message へ置換。
   - 対象: `src/app/i18n/locales/{en,ja}/auth.json, account.json, personal-data/actions.ts, email/actions.ts, storage/actions.ts, sign-in/sign-up actions ほか`
   - 根拠ID: auth-signout-case-drift,account-cancel-deletion-typo,en-account-body-hardcoded-japanese,auth-errors-magiclink-oauth-missing,zod-namespace-legacy-debris
2. **[M/低]** i18n 設定の cruft を整える。defaultNS を language code 'ja' から 'translation' へ修正、ファントム名前空間 docs/developer を namespaces 配列から除去、孤立キー main:showAll/account:data.canceledAccountDeletion を削除、params.lang を availableLanguages で検証し未知値を defaultLanguage へ矯正する。middleware.ts と lang-utils.ts の locale 検出重複、server.ts/client.tsx の i18n init 重複を共有ヘルパへ抽出する。
   - 対象: `src/app/i18n/settings.ts, server.ts, client.tsx, src/middleware.ts, src/lib/lang-utils.ts, locales/*/main.json, account.json`
   - 根拠ID: default-ns-misconfigured,orphan-namespaces-docs-developer,orphan-key-main-showall,untyped-lang-into-gettranslation,duplicated-locale-detection,duplicated-i18n-init
3. **[XL/低]** developer ポータル(約9ファイル)の i18n 化を行う。developer.json(en+ja)を新設し getTranslation/useTranslation を forms と actions に配線、ハードコード日本語をキーに置換する。フォーム単位で段階実施可能。namespaces への developer 追加はファイル整備後に行う。
   - 対象: `src/app/[lang]/(developer)/ 配下のフォーム・アクション, locales/{en,ja}/developer.json(新規), settings.ts`
   - 根拠ID: developer-section-no-i18n
4. **[M/低]** social links と nav links の重複データを共有モジュールへ抽出する。GitHub/X/Discord ブロックと nav リンクを socialLinks/navLinks 配列にし drawer/footer/nav-bar で map、footer の Discord alt='X' と drawer 全 social 画像 alt='GitHub' のコピペ誤りを修正する。
   - 対象: `src/components/{drawer,footer,nav-bar}.tsx, src/components/(新規データモジュール)`
   - 根拠ID: social-links-nav-duplication
5. **[M/低]** その他コンポーネント整備: nav-bar の生 Radix primitive バイパスをラップ済み navigation-menu に統一、ui/drawer 削除後に components/drawer.tsx を nav-drawer.tsx へリネーム、effects-demo の二重 JSX を [...effects,...effects] map へ、sign-in/sign-up フォームの共通 OAuth ハンドラ+Card chrome を共有コンポーネントへ抽出、authjs.* 監査ログ名前空間を auth へリネーム(永続文字列値は据置)、authjs.* 監査キーと Session_sessionToken_key 制約名等の NextAuth 残骸を整理する。
   - 対象: `src/components/nav-bar.tsx, drawer.tsx, effects-demo.tsx, sign-in/form.tsx, sign-up/form.tsx, src/lib/audit-log.ts, prisma/schema.prisma`
   - 根拠ID: navbar-bypasses-navigation-menu-wrapper,misleading-drawer-naming,effects-demo-duplicated-jsx,signin-signup-form-duplication,authjs-audit-log-namespace,nextauth-naming-leftovers

**完了条件(Exit Criteria)**: 全 t() 呼び出しが定義済みキーへ解決し生キー表示が無い、docs/developer 名前空間ロード失敗が消滅、developer ポータルが en/ja 両対応、social/nav リンクが単一データ源、画像 alt が正しいこと。

---

## Phase 7: ルーティング/レイアウト整理とエラーハンドリング堅牢化

**リスク**: 中 ／ **目安工数**: 1-1.5 weeks

**ゴール**: レイアウトの重複を共有 shell に集約し、欠落していた loading/error/not-found 境界と per-page metadata を追加し、Stripe webhook の冪等性とエラー境界を強化する。横断的な PII ログ・swallowed catch・env キャスト・logger を是正する。

**この順序である理由**: レイアウト/境界/metadata は純粋に追加的な Next 規約で外部 API に触れず低リスク。フェーズ6 で auth-flow chrome の重複が部分的に解消された後に共有レイアウト抽出を行うと整合する。Stripe webhook の冪等性は schema 制約確認を要するため独立した慎重なタスクとする。

**作業項目**:

1. **[M/中]** 4 つの near-identical な NavBar レイアウト((store)/(developer)/(storage)/(docs))を共有 page-shell コンポーネント(lang, children, footer? を受ける)に集約し、各グループレイアウトを 3 行ラッパにする。(main) と (auth-flow) に欠落しているレイアウトを追加し、inline NavBar/Footer と auth-flow の centered card + logo header + privacy link chrome を集約する。sign-in/sign-up の form タグ入れ子と sign-out の privacy link 不在に注意する。
   - 対象: `src/app/[lang]/(store)/layout.tsx, (developer)/developer/layout.tsx, (storage)/storage/layout.tsx, (docs)/docs/layout.tsx, (main)/(auth-flow) 配下, components/page-shell.tsx(新規)`
   - 根拠ID: identical-navbar-layouts,auth-flow-missing-layout,main-group-no-layout-inline-chrome
2. **[M/低]** loading/error/not-found 境界を追加する。ルート [lang]/ に error.tsx('use client'+reset)と not-found.tsx(既に notFound() を呼ぶ4ページが恩恵)、重い非同期セグメント((store)/store, checkout, billing)に loading.tsx を追加する。dynamic public ページ(store/[name], publishers/[name])に generateMetadata を追加し displayName/shortDescription/icon を OG に反映する。
   - 対象: `src/app/[lang]/error.tsx, not-found.tsx, loading.tsx 各所, store/[name]/page.tsx, publishers/[name]/page.tsx`
   - 根拠ID: no-loading-error-boundaries,no-per-page-metadata
3. **[M/中]** 手書きの session-check+redirect を authOrSignIn() に統一する。ただし inline 版が lang-prefixed redirect を emit するのに対しヘルパは lang-agnostic で middleware 依存である差異と、native-auth ページの returnUrl チェーン要件を考慮し、manage layout と account/page のみ直接適用、native-auth は据置またはパラメータ化ヘルパとする。manage/layout.tsx の lang-prefix 不整合を是正する。
   - 対象: `manage/layout.tsx, account/manage/profile/page.tsx ほか, src/lib/auth-guard.ts`
   - 根拠ID: inconsistent-session-guard-usage,duplicated-session-redirect-guard
4. **[M/中]** Stripe webhook を堅牢化する。constructEvent を try/catch で囲み署名失敗時 400、ハンドラ本体を囲み DB エラー時 Stripe 再送可能な 500 を返す。UserPackage は複合 PK 済みなので upsert/findFirst ガード、UserPaymentHistory は paymentId に @unique を追加する migration を伴い冪等化する。bare throw でなく構造化ログへ。
   - 対象: `src/app/api/stripe/webhook/route.ts, prisma/schema.prisma(UserPaymentHistory @unique), 新規 migration`
   - 根拠ID: stripe-webhook-no-error-boundary
5. **[M/低]** 横断的なエラーハンドリング/型/ログ衛生を是正する。currency.ts の本番 PII(IP/country)console.log を削除、swallowed catch(security/page.tsx の GitHub fetch, account.ts のトークン復号)にログ追加、薄い logging モジュールを導入し .onError とアクションエラーを context 付きで通す、process.env.X as string キャストを zod env スキーマ(env.ts)で起動時検証へ、any 型の STATUS_CONTENT_MAP/countryToCurrency を typed Record へ、File.size の BigInt/number 混在処理を lib/db/file.ts に集約する。
   - 対象: `src/lib/currency.ts, security/page.tsx, api/v1/account.ts, src/lib/env.ts(新規), checkout/complete/components.tsx, src/lib/db/file.ts`
   - 根拠ID: pii-ip-logging-currency,swallowed-catch-blocks,console-as-error-channel,env-var-as-string-casts,any-typed-status-and-currency-maps,bigint-int-churn-residue
6. **[M/低]** DB schema の二次インデックスを追加する。FK/スキャン列(File.userId, Package.userId, Release.packageId, UserPackage.packageId, UserPaymentHistory.userId, AuditLog.userId)に @@index、AppReleaseAsset に複合インデックス(version,type,os,arch,standalone)を追加し additive な migration を 1 本生成する。updatedAt 規約と Verification unique 制約のドキュメント整備も行う。
   - 対象: `prisma/schema.prisma, 新規 migration`
   - 根拠ID: no-secondary-indexes,updatedat-convention-inconsistency,verification-unique-constraint-lost-in-squash

**完了条件(Exit Criteria)**: レイアウト重複が共有 shell に集約、ルートに error/not-found 境界が存在、public ページに per-page metadata、Stripe webhook が署名失敗で 400・冪等な書き込み、PII ログ消滅、env が起動時検証され、FK インデックスが追加済みであること。

---

## Phase 8: 外部契約の撤去 (テレメトリ gate 付き・最終フェーズ)

**リスク**: 高 ／ **目安工数**: 1-2 weeks (テレメトリ待ち含むため期間は前後する)

**ゴール**: デスクトップアプリが消費する legacy 経路を、クライアントテレメトリで未使用が確認できた範囲で deprecated マーキングののち撤去する。token 発行ロジックを共有層へ抽出する。

**この順序である理由**: 最も blast radius が大きく外部契約に直接触れるため最後に置く。各撤去は最古サポート対象デスクトップビルドが該当パスを呼ばないテレメトリ確認を gate 条件とする。確認が取れるまでは deprecated コメント付与のみで温存する。

**作業項目**:

1. **[M/高]** 撤去候補を deprecated マークし、テレメトリ確認後に撤去する。v1/app/checkForUpdates(v3/app/updates が上位互換、撤去後 BEUTL_*_VERSION 削除)、v2/identity/signInWith(native-auth への単一リダイレクトシム)、/account/signIn camelCase ページ、dead な v1/account/handler エンドポイント(page handler が live)。各々まず deprecated コメント、telemetry gate で削除。
   - 対象: `src/app/api/v1/[[...route]]/app.ts, src/app/api/v2/identity/signInWith/route.ts, src/app/[lang]/(auth-flow)/account/signIn/page.tsx, src/app/api/v1/[[...route]]/account.ts`
   - 根拠ID: v1-checkforupdates-superseded,v2-single-route-legacy-redirect,deprecated-camelcase-signin-page,dead-v1-handler-endpoint
2. **[S/中]** native-auth handler の localhost 固定バグを修正する。page handler が continueUrl を localhost 以外で 'Invalid continue URL' を throw し本番デスクトップログインを壊している。createAuthUri の許可リスト(localhost と beutl.beditor.net)に揃え、共有定数/env 経由にする。実本番 continueUrl ホストを確認の上で適用し、line 59 の死んだコメントアウト redirect を除去する。
   - 対象: `src/app/[lang]/(auth-flow)/account/native-auth/handler/page.tsx`
   - 根拠ID: localhost-only-native-handler-bug
3. **[M/高]** v1/account を retirable legacy と誤認しないよう依存を文書化する。v1/account は唯一の token 発行面(createJwtToken/createRefreshToken)で全 v3 認証が getUserId 経由で依存する旨を ADR/コメントで記録する。将来の統合時は token crypto/発行を v1/account.ts から lib/api/auth.ts へ抽出し、claim 名と refresh-token 暗号化形式をデスクトップ向けにバイト互換で保つ。v1/account は削除しない。
   - 対象: `src/app/api/v1/[[...route]]/account.ts, src/lib/api/auth.ts, docs/(ADR)`
   - 根拠ID: v1-is-auth-backbone-not-retirable
4. **[S/中]** missing /account/error ページを解消する。magic-link 失敗時の errorCallbackURL が存在しないルートを指し 404 になるため、最小 error ページを作る(lang prefix 付与)か /account/sign-in?error=magicLink へ変更し、better-auth.ts の死んだ pages:{} コメントブロックを削除する。about/privacy・about/telemetry リダイレクトスタブはデスクトップ deep link 確認後に整理する。
   - 対象: `sign-in/actions.ts, sign-up/actions.ts, src/lib/better-auth.ts, (auth-flow)/account/error/(新規 or 不要), (docs)/about/`
   - 根拠ID: missing-account-error-page,about-vs-docs-redirect-stubs

**完了条件(Exit Criteria)**: legacy 経路に deprecated マークが付き、テレメトリ確認済みのものは撤去され該当 env が削除済み、native-auth handler が本番ホストを受理、v1/account の auth backbone 依存が文書化され、magic-link 失敗が有効なエラー画面へ遷移すること。撤去の各ステップでデスクトップアプリの該当フローを実機確認すること。

---

## 横断的リスク(フェーズをまたいで注意すべき点)

- 外部 API 契約(v1/v2/v3)のバイト等価性: デスクトップアプリは v3 の packages/users/discover/library/files の JSON を直接消費する。マッパー統合(フェーズ3)・直接呼び出し移行(フェーズ4)・errorCodes/api-errors 整理(フェーズ2)はいずれも応答 shape を変えうるため、現行 emit 値(paid, bio の null vs undefined, logoId/iconId の null 有無, FileResponse.size の number)をゴールデン値として固定し、リファクタ後にバイト等価を検証する必要がある。スナップショット/契約テストが現状存在しないため、これらの導入自体が前提作業となる。
- native-auth フローと JWT 発行(認証): v1/account は唯一の token 発行面で全 v3 認証が依存する。JWT クレーム名(xmlsoap nameidentifier)・HS256 署名・PBKDF2/AES-CBC refresh-token 暗号化形式・native-auth の continueUrl 契約はデスクトップアプリと厳密に結合しており、いかなる抽出・統合でもバイト互換を保つ必要がある。localhost 固定バグ修正と handler 統合は本番 continueUrl ホストの実確認を要する。
- Stripe/決済: webhook は冪等性ガードが無く、payment_intent.succeeded 再送で UserPaymentHistory が重複しうる(UserPackage は複合 PK で保護済み)。冪等化には @unique 追加の DB migration が必要で、決済パスのため慎重なテストを要する。
- DB migration とプロバイダ整合: **実エンジンは CockroachDB と確定済み（2026-06-23）**。schema/migration_lock はすでに cockroachdb で正しく、プロバイダ切替は行わない。`@prisma/adapter-pg` で接続できるのは Cockroach の pg ワイヤ互換による。以降の index 追加・@unique 追加マイグレーションは **cockroachdb 前提**で生成し、live Hyperdrive に対する drift/shadow-DB に注意する。
- テレメトリ依存の撤去 gate: legacy 外部経路(v1/checkForUpdates, v2/signInWith, /account/signIn, dead handler)の削除は最古サポート対象デスクトップビルドが呼ばないことの確認を絶対の前提とする。テレメトリが無ければ削除せず deprecated マーキングに留め、最終フェーズに後送りする。
- Cloudflare Workers ランタイム制約: PrismaClient の memoization は module-scoped singleton が isolate 跨ぎでリークし Hyperdrive の per-request 接続モデル(maxUses:1)と衝突するため、request/isolate-scoped に厳密に閉じる必要がある。sync getDb 削除のみは安全だが memoization は別タスクとして慎重に扱う。

## 成功指標(メトリクス)

- 削除した死ファイル/LOC: 確認済み死ファイル 4+(443 LOC)+ 死 UI プリミティブ 3 + 死 CSS/フォント/アセット。LOC 削減量を計測。
- 除去した npm 依存数: vaul, react-hook-form, @hookform/resolvers, @radix-ui/react-tabs, @biomejs/biome の 5 つ(+lockfile スリム化)。
- データアクセス経路の単一化: パッケージ読み出しマッパー 5〜6 → 1、@/prisma 直接 import が src/lib/db + better-auth.ts のみ(lint で強制)、sync getDb の消滅。
- 設定の真実源一本化: デプロイ先 3 → 1(Cloudflare)、lint ツール 2 → 1、DB provider 宣言の整合(**cockroachdb で確定**、better-auth の postgresql 設定は pg ワイヤ互換で動作)、Node バージョン宣言 4 → 1。
- i18n 健全性: 壊れた/欠落キー 0、ファントム名前空間 0、developer ポータルの en/ja カバレッジ、孤立キー 0。
- .env.sample とコード使用の一致(未文書化キー 0、未使用キー 0)。
- DB インデックス: 0 → FK/スキャン列への @@index 追加、AppReleaseAsset 複合インデックス。
- 外部 API 応答のゴールデン値テスト導入数とバイト等価合格率(リグレッション 0)。
- 撤去した legacy 外部経路数(テレメトリ gate 通過分)と関連 env(BEUTL_*_VERSION)の削減。

---

## 付録: 監査の発見一覧(12次元)

各フェーズの作業項目はここの発見IDに紐づきます。`重要度` は無駄/害の大きさ、`リスク` はリファクタの破壊リスク(検証後の補正値)。

### API VERSIONING SPRAWL (v1/v2/v3)

Three coexisting API versions serve the external Beutl desktop app, but they are NOT three generations of the same surface — they partition responsibilities. v1 is the authentication backbone (it is the ONLY place that mints JWT/refresh tokens via createJwtToken/createRefreshToken; all v3 endpoints authenticate by validating those v1-issued tokens through lib/api/auth.ts), plus a now-obsolete v1/app/checkForUpdates that v3/app/updates supersedes. v2 is a single legacy redirect route into the still-live native-auth flow. v3 is the current package/library/discover/user read surface. The real waste is: (1) lib/api/types.ts is 100% dead (zero imports; the six response interfaces are never used and one has a 'paied' typo); (2) AppType type exports in v1/v3 route.ts are dead (no hono/client consumer); (3) three independent package-to-JSON mappers exist (discover.ts mapPackage, library.ts createResponse, lib/api/packages-db.ts mapPackage) that build near-identical owner/pricing/logo shapes by hand; (4) a missing await in v3/app.ts:78 serializes a Promise as a 404 body; (5) v1/app/checkForUpdates is functionally superseded by v3/app/updates. Because real desktop clients in the wild call these paths, only internal-cleanup items (dead types, dead type exports, duplicated mappers, the await bug) are safe; the route trees themselves must stay until client telemetry proves a version is unused. The recon's premise that lib/api/packages-db.ts overlaps lib/db/package.ts is mostly false: lib/db/package.ts is developer-portal write CRUD ("Dev" functions), packages-db.ts is public store read/map — they share no functions.

| ID | 重要度 | 種別 | 内容 | 推奨対応 | 工数 | リスク |
|----|:---:|------|------|---------|:--:|:--:|
| `dead-api-types-file` | 中 | dead-code | All six exported interfaces (ProfileResponse, SimplePackageResponse, PackageResponse, ReleaseResponse, AcquirePackageResponse, FileResponse) are never imported anywhere in src/.… | Either delete lib/api/types.ts outright, or (better for an external contract) wire it in: make the v3 handlers' return objects satisfy these interfaces (e.g.… | S | 低 |
| `three-package-mappers` | 高 | duplication | The package-to-response transformation is implemented three independent times, each re-deriving the same owner block (id/name/displayName/bio/iconId/iconUrl), the same currency/… | Extract a shared mapper module (e.g. lib/api/package-mappers.ts) exposing toOwner(profile), pickPrice(pricing, currency), toSimplePackage(pkg,...), toFullPac… | M | 中 |
| `missing-await-error-response` | 高 | risky-pattern | apiErrorResponse is async (returns Promise<ApiErrorResponse>). Every call site in the codebase awaits it except v3/app.ts:78, which passes the un-awaited Promise directly to c.j… | Add the missing await: `return c.json(await apiErrorResponse("assetNotFound"), { status: 404 });`. Trivial, high-value fix. Optionally add a lint rule / make… | S | 低 |
| `v1-checkforupdates-superseded` | 中 | legacy-debris | Two update-check endpoints exist. v1 app.ts GET /checkForUpdates/:version reads a single hardcoded env-var version (BEUTL_LATEST_VERSION / BEUTL_REQUIRED_VERSION) and returns {l… | Treat v1/app/checkForUpdates as deprecated. Do NOT delete yet (old desktop builds call it), but: add a code comment marking it deprecated-in-favour-of-v3/app… | S | 低 |
| `v1-is-auth-backbone-not-retirable` | 中 | missing-abstraction | It would be natural to assume 'v3 is newest, retire v1/v2'. That is wrong and worth recording so a future cleanup doesn't break auth. v1/account is the ONLY place that mints acc… | Document this dependency (a comment in v1/account/route or a short ADR) so v1 is not mistaken for retirable legacy. If consolidation is desired, first extrac… | M | 高 |
| `dead-apptype-exports` | 低 | dead-code | Both v1/[[...route]]/route.ts and v3/[[...route]]/route.ts export `export type AppType = typeof route;`. This pattern exists so a hono/client (`hc<AppType>`) can get end-to-end … | Delete the two `export type AppType` lines (and the `route` intermediate const can be inlined into `handle(app)` if desired). Zero runtime impact, slightly f… | S | 低 |
| `v2-single-route-legacy-redirect` | 低 | legacy-debris | The entire v2 'version' is a single 12-line redirect: GET /api/v2/identity/signInWith reads provider+returnUrl and 302s to /{lang}/account/native-auth/sign-in-with. The actual s… | Keep as-is for now (external desktop builds may hit it), but mark it deprecated with a comment and fold it mentally into 'native-auth compat shims', not a re… | S | 高 |
| `duplicated-onerror-handler` | 低 | duplication | v1/[[...route]]/route.ts and v3/[[...route]]/route.ts contain a byte-identical onError block: console.error(err); if HTTPException return getResponse(); if JwtTokenExpired retur… | Extract a shared `apiOnErrorHandler` into lib/api/error.ts and reference it from both route trees: `app.route(...).onError(apiOnErrorHandler)`. Centralizes t… | S | 低 |
| `duplicated-jwt-extraction-auth` | 低 | duplication | lib/api/auth.ts defines getUserId(c: Context) and getUserIdFromHeaders(headers: Headers) with line-for-line identical bodies — the only difference is the header source (c.req.he… | Collapse to one core function `verifyBearer(authHeader: string / null): Promise<string / null>` and have getUserId(c) call it with c.req.header('Authorizatio… | S | 低 |

### AUTH FLOW DEBRIS (NextAuth -> better-auth migration)

The NextAuth -> better-auth migration is functionally complete: there are zero remaining `next-auth`/`getServerSession`/`authOptions` references in source, and `better-auth` is the only auth dependency. The real live flow is clean: web users hit `account/sign-in` (magic-link + Google/GitHub OAuth + passkey) / `account/sign-up` / `account/verify-request` / `account/sign-out`, and the Beutl desktop app drives a separate `native-auth/*` flow backed by the v1 Hono API (`createAuthUri` -> page `native-auth/handler` -> `code2jwt`). The debris is concentrated in: (1) three one-off migration scripts that reference now-dropped tables, (2) an explicitly-deprecated camelCase `signIn/` page with no inbound references, (3) a dead duplicate `/api/v1/account/handler` Hono endpoint shadowed by the page handler, (4) NextAuth-era `authjs.*` audit-log naming, (5) a missing `/account/error` page referenced by both sign-in/sign-up actions, and (6) a hard-coded `localhost`-only guard in the page-based native-auth handler that breaks production desktop login. Sign-in and sign-up forms are also near-duplicates. None of the genuinely-dead items are referenced by the desktop app, so most can be removed safely; the localhost bug and missing error page are correctness issues, not just waste.

| ID | 重要度 | 種別 | 内容 | 推奨対応 | 工数 | リスク |
|----|:---:|------|------|---------|:--:|:--:|
| `deprecated-camelcase-signin-page` | 中 | legacy-debris | src/app/[lang]/(auth-flow)/account/signIn/page.tsx is a thin redirect whose own header comment says it is kept only for desktop-app backward compat and is no longer used ("互換用に残… | Confirm with the desktop-app release that no shipped/maintained client version requests the camelCase /account/signIn URL. If old clients are no longer suppo… | S | 低 |
| `dead-v1-handler-endpoint` | 中 | duplication | There are TWO implementations of the native-app auth 'handler' step. The page handler at native-auth/handler/page.tsx is the one actually wired into the desktop flow: createAuth… | Delete the `.get("/handler", ...)` route from src/app/api/v1/[[...route]]/account.ts (lines 178-217) since createAuthUri points at the page handler. Before d… | S | 低 |
| `localhost-only-native-handler-bug` | 高 | risky-pattern | native-auth/handler/page.tsx throws 'Invalid continue URL' whenever the continueUrl hostname is not exactly 'localhost' (line 56). This is the live handler the desktop flow uses… | Align the page handler's host allow-list with createAuthUri (allow beutl.beditor.net and any other production origins, ideally via a shared constant or env v… | S | 中 |
| `missing-account-error-page` | 中 | dead-code | Both magic-link actions pass errorCallbackURL: "/account/error", but there is no error page under (auth-flow)/account/. The directory contains only native-auth, page.tsx, sign-i… | Either create a minimal /account/error page (mirroring verify-request/page.tsx) or change errorCallbackURL to an existing route such as /account/sign-in?erro… | S | 低 |
| `oneoff-migration-scripts` | 中 | legacy-debris | scripts/migrate-auth-data.ts, scripts/convert-credential-id-base64url.ts, and scripts/delete-passkey-accounts.ts are one-time DB migration scripts written against the Auth.js->B… | Archive or delete these three scripts now that the migration has shipped (HEAD is post-better-auth). If history must be retained, move them to a docs/migrati… | S | 低 |
| `authjs-audit-log-namespace` | 低 | inconsistency | The audit-log action namespace still uses `authjs` (auditLogActions.authjs.createUser/signIn/signOut/linkAccount) even though Auth.js/NextAuth was removed and the events are now… | Low priority. Renaming the TS identifier from `authjs` to `auth` is safe, but changing the persisted string values would split historical audit rows. Recomme… | S | 低 |
| `signin-signup-form-duplication` | 低 | duplication | sign-in/form.tsx and sign-up/form.tsx share the bulk of their markup and the OAuth handler: identical logo/Card layout, identical handleOAuthSignIn implementation (authClient.si… | Extract the shared OAuth handler and the OAuth-buttons Card (Google/GitHub, plus optional passkey slot) into a shared component, e.g. components/auth/oauth-b… | M | 低 |
| `inconsistent-session-guard-usage` | 低 | inconsistency | src/lib/auth-guard.ts provides authOrSignIn(), authenticated(), and throwIfUnauth() as the intended abstractions, but many pages bypass them and re-implement the same getSession… | Standardize manage-account pages on authOrSignIn() (which centralizes the returnUrl/x-url handling) instead of inline getSession+redirect, and fix the lang-p… | M | 低 |

### Data Access Layer Duplication

The data-access layer is split three ways: a curated function layer under src/lib/db/* (8 files, transaction-aware), two parallel "package read" helper modules (lib/api/packages-db.ts and lib/store-utils.ts), and pervasive direct getDbAsync()/getDb() calls in ~28 route/action/page files. No single table is owned by one access path: the package table is queried 28 times directly despite a 555-line db/package.ts, and userPackage/release/profile have zero db-layer coverage and are always accessed inline. There are three near-identical package-by-name selectors, two customer modules, and two content-URL construction styles. The reverted Prisma->Drizzle migration left the source tree clean (only a transitive peer-dep echo remains in pnpm-lock.yaml). The fix is to consolidate on the db/* function-layer pattern, fold the two package helpers and lib/customer.ts into it, and forbid direct prisma access outside src/lib/db.

| ID | 重要度 | 種別 | 内容 | 推奨対応 | 工数 | リスク |
|----|:---:|------|------|---------|:--:|:--:|
| `split-direct-vs-dblayer` | 高 | duplication | The codebase has a deliberate function-based data-access layer in src/lib/db/* (every function takes an optional prisma?: PrismaTransaction and resolves db = prisma // await get… | Pick ONE pattern and enforce it: the src/lib/db/* function layer is the better-developed one, so make it the single sanctioned data-access surface. Move the … | XL | 中 |
| `package-read-three-layers` | 高 | duplication | Reading a package by name/query is implemented three independent times against the same Package table with overlapping select trees (id, name, displayName, description, shortDes… | Collapse into one package module (extend src/lib/db/package.ts). Express the variants as parameters: a shared base selector, a published-only filter flag, an… | L | 高 |
| `two-customer-modules` | 中 | duplication | There are two modules touching the Customer table and Stripe customers. lib/db/customer.ts holds updateCustomerEmailIfExist (transaction-aware, follows the db/* pattern). lib/cu… | Merge createOrRetrieveCustomerId into src/lib/db/customer.ts and give it the same prisma?: PrismaTransaction signature as the rest of the layer, then delete … | S | 低 |
| `tables-with-no-db-layer` | 中 | missing-abstraction | The db/* layer covers user, account, customer, file, package, passkey, transaction, user-payment-history. But three heavily-used tables have no curated functions at all and are … | Add db/user-package.ts (owns add/remove/exists library ownership), db/release.ts (create/update/delete/publish/findByPackage), and db/profile.ts (read/update… | L | 中 |
| `getcontenturl-two-styles` | 中 | inconsistency | Building the /api/contents/<fileId> URL is done two incompatible ways. getContentUrl in db/file.ts reads the x-url request header, parses the origin, and returns an ABSOLUTE URL… | Move getContentUrl out of db/file.ts into a non-DB helper (e.g. lib/storage.ts or a small lib/content-url.ts), and have it accept a flag for absolute vs rela… | M | 低 |
| `transaction-param-inconsistency` | 低 | inconsistency | The db/* layer's signature contract is 'every function takes prisma?: PrismaTransaction and falls back to getDbAsync()'. A few functions break it: upsertPackagePricings in db/pa… | Standardize the signature: add prisma?: PrismaTransaction to upsertPackagePricings and createOrRetrieveCustomerId, using db = prisma // await getDbAsync() an… | S | 低 |
| `prisma-client-per-call` | 中 | risky-pattern | src/prisma.ts exports two near-duplicate factories (getDb sync, getDbAsync async) that differ only in how they await getCloudflareContext, and each calls `new PrismaClient({ ada… | Collapse to one factory and memoize the PrismaClient per request/context instead of per call (e.g. cache on the Cloudflare context or a request-scoped store)… | M | 中 |
| `drizzle-revert-residue` | 低 | config-cruft | The Prisma->Drizzle migration reverted in HEAD (commit 78ad03f) was cleaned up well at the source level: there is no drizzle.config, no src/db schema dir, no drizzle/ migrations… | No action required beyond an optional `pnpm install`/lockfile refresh to drop the stale peer-dep echo if a future dependency bump doesn't already. Do not spe… | S | 低 |

### Component/UI duplication & demo code

The component layer is mostly lean and all demo/landing components (easing-demo, effects-demo, hero-section, animated-section, stagger-children, platform-icons, floating-elements, features-toc) are genuinely rendered on the main landing page — none are stray demo code shipping by accident. The real waste is three fully unused shadcn UI primitives (ui/drawer.tsx pulling in the otherwise-dead `vaul` dependency, ui/tabs.tsx, ui/form.tsx at 179 LOC), an empty src/components/effects-demo/ directory, an unused CSS module, and copy-paste duplication: the effects list rendered twice in effects-demo.tsx and the GitHub/X/Discord social block plus nav links duplicated across drawer.tsx, footer.tsx, and nav-bar.tsx. There is also a naming collision (components/drawer.tsx is actually a Sheet, not a drawer) and an inconsistency where nav-bar.tsx bypasses its own navigation-menu wrapper for the raw Radix primitive. None of these touch the external desktop-app API surface, so refactor risk is uniformly low.

| ID | 重要度 | 種別 | 内容 | 推奨対応 | 工数 | リスク |
|----|:---:|------|------|---------|:--:|:--:|
| `unused-vaul-drawer` | 中 | dead-code | src/components/ui/drawer.tsx is the shadcn vaul-based Drawer primitive (Drawer, DrawerContent, DrawerTrigger, etc., 118 LOC). Nothing in the codebase imports it. The app's only … | Delete src/components/ui/drawer.tsx and remove the `vaul` dependency from package.json. No imports to update. | S | 低 |
| `unused-ui-form` | 中 | dead-code | src/components/ui/form.tsx is the shadcn react-hook-form integration (Form, FormField, FormItem, FormControl, useFormField, etc.), the largest UI primitive at 179 LOC. No file i… | Delete src/components/ui/form.tsx. If react-hook-form is not used elsewhere, also check whether the `react-hook-form` and `@hookform/resolvers` deps can be d… | S | 低 |
| `unused-ui-tabs` | 低 | dead-code | src/components/ui/tabs.tsx (Radix Tabs wrapper, 55 LOC) has no importers. No Tabs/TabsList/TabsTrigger/TabsContent usage anywhere in the app. | Delete src/components/ui/tabs.tsx (it depends on @radix-ui/react-tabs; check if that dep is used elsewhere before removing the package). | S | 低 |
| `empty-effects-demo-dir` | 低 | legacy-debris | There is both a file src/components/effects-demo.tsx (the real component) and a directory src/components/effects-demo/ that contains no files. The empty dir is leftover scaffold… | Remove the empty src/components/effects-demo/ directory. | S | 低 |
| `effects-demo-duplicated-jsx` | 低 | duplication | EffectsDemo maps over the same `effects` array (28 entries) and emits two identical <ul> blocks back-to-back, each rendering every effect as a Card. The two blocks are byte-for-… | Render the duplicate by mapping over `[...effects, ...effects]` or extracting a single <EffectsRow effects={effects}/> rendered twice, so the card markup liv… | S | 低 |
| `social-links-nav-duplication` | 中 | duplication | The GitHub/X/Discord social block (identical hrefs https://github.com/b-editor, https://x.com/yuto_daisensei, https://discord.gg/Bm3pnVc928 with the same /img/github-color.svg, … | Extract a shared `socialLinks` and `navLinks` data array (href + icon + translation key) into one module and map over it in drawer, footer, and nav-bar. Fix … | M | 低 |
| `navbar-bypasses-navigation-menu-wrapper` | 低 | inconsistency | components/nav-bar.tsx imports the wrapped helpers (NavigationMenuContent, NavigationMenuItem, NavigationMenuLink, NavigationMenuList, navigationMenuTriggerStyle) from ./ui/navi… | Use the wrapped NavigationMenu, NavigationMenuTrigger, and NavigationMenuViewport from ui/navigation-menu in nav-bar.tsx so styling lives in one place and th… | S | 低 |
| `misleading-drawer-naming` | 低 | inconsistency | components/drawer.tsx exports StandardDrawer, which is actually built on ui/sheet.tsx (Radix dialog slide-in), not on any drawer primitive. Meanwhile ui/drawer.tsx is the real (… | After deleting the unused ui/drawer.tsx, rename components/drawer.tsx to something like nav-drawer.tsx or mobile-nav.tsx (it is the mobile nav sheet) and upd… | S | 低 |
| `unused-fluid-css-module` | 低 | dead-code | The CSS module src/styles/fluid.module.css has zero importers across src. All other style modules (animated-border, easing-demo, grow, hero-gradient, loop-slide, transparent) ar… | Delete src/styles/fluid.module.css. | S | 低 |

### Server Actions Structure & Duplication

The server-action layer is functional but riddled with copy-paste boilerplate and one genuine latent bug. Three patterns repeat across nearly every file: the auth wrapper closure, the `getLanguage() -> revalidatePath(\`/${lang}/...\`)` epilogue (35 occurrences), and the validate-with-zod-then-return-field-errors preamble. The largest file (developer/projects/[name]/actions.ts, 793 LOC) holds ~12 near-identical CRUD actions that each re-implement auth + ownership check + audit log + revalidate, mixes inline Prisma with lib/db helpers, makes an extra DB round-trip per action to fetch the package name, and contains a missing-`await` bug in moveScreenshot that breaks revalidation. The store package-listing logic (ListedPackage DTO + currency/pricing where-clause + icon-URL mapping) is duplicated across at least five files. Error/response shapes are inconsistent (some return {success,message}, one returns {error}, several throw, and two actions use the wrong Zod error accessor). The clearest wins are a shared action wrapper (auth + ownership + revalidate + audit) and consolidating package-listing into the already-existing lib/store-utils.ts.

| ID | 重要度 | 種別 | 内容 | 推奨対応 | 工数 | リスク |
|----|:---:|------|------|---------|:--:|:--:|
| `move-screenshot-missing-await` | 高 | risky-pattern | In moveScreenshot, the package name is fetched without await: `const name = getPackageNameFromPackageId({ packageId });`. getPackageNameFromPackageId is an async function return… | Add the missing `await`: `const name = await getPackageNameFromPackageId({ packageId });`. A shared revalidate helper (see action-wrapper finding) that takes… | S | 低 |
| `auth-revalidate-boilerplate` | 高 | duplication | Almost every mutating action follows the identical shape: `return await authenticated(async (session) => { ... const lang = await getLanguage(); revalidatePath(\`/${lang}/<route… | Introduce a shared action helper in lib (e.g. `formAction`/`mutation`) that wraps `authenticated`, resolves `lang` once, runs the body, optionally writes the… | L | 中 |
| `listed-package-mapper-duplication` | 高 | duplication | The exact same `ListedPackage` type plus the packagePricing `where` clause (currency-insensitive OR fallback), the `find(currency) // find(fallback) // [0]` price-selection, and… | Extract one canonical `ListedPackage` type and a `mapPackageToListed(pkg, currency)` mapper plus a shared `packagePricingWhere(currency)` select fragment int… | M | 中 |
| `oversized-developer-projects-file` | 中 | complexity | This single file holds 12+ exported actions covering display-name, description, delete, visibility, icon, screenshots (add/move/delete), tags, releases (create/update/delete), p… | Split into cohesive modules: package-meta actions, screenshot actions, release actions (and move release DB calls into lib/db/release.ts), and admin pricing/… | L | 中 |
| `confirmation-token-email-flow-duplication` | 中 | duplication | email/actions.ts and personal-data/actions.ts each define a local `sendEmail(email, token[, lang])` helper that does the same thing (read x-url header, build a URL, clear search… | Extract a `createConfirmationToken({ userId, identifier, purpose })` and a `consumeConfirmationToken({ token, identifier, purpose })` into lib/db (or lib/con… | M | 低 |
| `inconsistent-error-response-shapes` | 中 | inconsistency | Actions disagree on how to report outcomes. Most return `{ success: boolean; message?: string }` or a `State` with `errors` field. But security/actions.ts deletePasskey returns … | Define one shared `ActionResult<T>` (e.g. `{ success: true; data?: T } / { success: false; message?: string; errors?: ... }`) in lib and use it everywhere; c… | M | 低 |
| `zod-error-message-wrong-accessor` | 中 | inconsistency | Two actions surface validation errors via `validated.error.message ?? "入力内容に誤りがあります"`. Zod's ZodError.message is a JSON-stringified array of all issues (a developer-facing blob)… | Replace with `validated.error.flatten().fieldErrors` (or a single localized message). Fold into the shared zod-validation preamble helper so all actions form… | S | 低 |
| `validation-preamble-duplication` | 低 | duplication | The pattern `const validated = schema.safeParse(Object.fromEntries(formData.entries())); if (!validated.success) return { errors: validated.error.flatten().fieldErrors, message:… | Add a `parseForm(schema, formData)` helper that runs safeParse on the entries and returns either data or a standardized localized error State (using t). Stan… | M | 低 |
| `retrievepackages-name-collision` | 低 | inconsistency | At least four exported functions are named `retrievePackages`, each with a different signature and return DTO: developer/actions.ts (no args, returns dev `Package[]` with latest… | Rename to intent-revealing names (retrieveDeveloperPackages, retrieveOwnedPackages, searchPublishedPackages, retrievePublisherPackages) and centralize the pa… | S | 低 |

### I18N STRUCTURE

The i18n setup (i18next + react-i18next, server.ts/client.tsx/settings.ts) is structurally sound and en/ja JSON files are mostly in lockstep, but there are several concrete, verifiable defects: a case-mismatch and a typo that produce broken translations at runtime, a whole feature area (the developer portal, ~13 files) that bypasses i18n with hardcoded Japanese while still declaring a phantom `developer` namespace, legacy `zod:`-prefixed translation calls left over after the zod-i18n-map removal that resolve to raw keys, api-error codes that have no matching locale entry (leaking raw keys to the desktop app), and orphan/unused keys and namespaces. There is also dead language-context plumbing and duplicated locale-detection logic between middleware.ts and lang-utils.ts. None of these are speculative; each was confirmed by reading the code and cross-referencing usage.

| ID | 重要度 | 種別 | 内容 | 推奨対応 | 工数 | リスク |
|----|:---:|------|------|---------|:--:|:--:|
| `auth-signout-case-drift` | 高 | inconsistency | The auth namespace is the only one with structural drift between locales. en/auth.json defines 'signOut' (camelCase) while ja/auth.json defines 'signout' (lowercase). The sign-o… | Rename the ja key from 'signout' to 'signOut' to match en and the code. Verify no other code path references 'auth:signout'. | S | 低 |
| `account-cancel-deletion-typo` | 高 | inconsistency | The personal-data action returns a success message t("account:data.cancelAccountDeletion"), but neither en nor ja account.json defines that key — both define data.canceledAccoun… | Pick one spelling. Either change the code to t("account:data.canceledAccountDeletion") (matches existing locale) or rename the locale key. The former is the … | S | 低 |
| `en-account-body-hardcoded-japanese` | 高 | inconsistency | In en/account.json, the account-deletion confirmation email body is written entirely in Japanese (identical to the ja value), including '以下のリンクをクリックしてアカウントを削除できます' and the link … | Translate the en body to English (e.g. 'Click the link below to delete your account' / link text 'Delete account'). | S | 低 |
| `developer-section-no-i18n` | 高 | missing-abstraction | The whole (developer) route group — project creation, package info/description/details/pricing/release/screenshot forms, the developer landing page, and server actions (validati… | Create developer.json locale files (en+ja), wire useTranslation/getTranslation through the developer components and actions, and replace literals with keys. … | XL | 低 |
| `zod-namespace-legacy-debris` | 高 | legacy-debris | Commit 9adb054 'remove zod-i18n-map integration' deleted the zod/i18next bridge, but four t("zod:...") calls remain. 'zod' is not in the namespaces array and there are no zod.js… | Replace these with real validation messages: either dedicated keys in an existing namespace, or rely on zod's own localized message (validated.error.issues[]… | M | 低 |
| `api-errors-code-key-drift` | 高 | inconsistency | apiErrorResponse(code) builds message: t(`api-errors:${errorCode}`). Two error codes that are actively returned by API routes — 'unknown' and 'invalidVersionFormat' — have no ke… | Add 'unknown' and 'invalidVersionFormat' entries to en+ja api-errors.json. Decide whether the two orphan keys (disallowedContentType, disposableEmailAddresse… | S | 低 |
| `auth-errors-magiclink-oauth-missing` | 高 | inconsistency | Sign-in/sign-up flows and the security panel surface error toasts/messages via t("auth:errors.magicLink") and t("auth:errors.oauth"), but auth.json only defines errors.passkey. … | Add errors.magicLink and errors.oauth to en/auth.json and ja/auth.json. | S | 低 |
| `orphan-namespaces-docs-developer` | 中 | config-cruft | settings.ts declares 11 namespaces and passes ns: namespaces to i18next, but only 9 have JSON files. 'docs' and 'developer' have no en/ja JSON and are never referenced via t("do… | Remove 'docs' and 'developer' from the namespaces array until backed by real locale files (the docs pages under (docs)/ are static Japanese pages and the dev… | S | 低 |
| `default-ns-misconfigured` | 中 | risky-pattern | getOptions returns defaultNS: defaultLanguage where defaultLanguage is 'ja'. defaultNS is supposed to be a namespace name; 'ja' is not in the namespaces list. The setup only wor… | Set defaultNS: 'translation' (or namespaces[0]) so the configured default namespace is the one actually used. | S | 低 |
| `dead-language-context` | 中 | dead-code | client.tsx defines LanguageContext, LanguageProvider, useLanguage, and setLanguage, and layout.tsx mounts <LanguageProvider initialLanguage={lang}>. But useLanguage() and setLan… | Remove LanguageContext/LanguageProvider/useLanguage/setLanguage and the layout mount, or actually use the context. Since lang comes from the URL, removal is … | S | 低 |
| `duplicated-locale-detection` | 低 | duplication | getNegotiatedLanguage (Negotiator wrapper) and the pathnameIsMissingLocale computation are implemented twice, near-verbatim, in middleware.ts and lib/lang-utils.ts. Both import … | Extract a shared helper (e.g. negotiateLanguage(acceptLanguage) and isPathnameMissingLocale(pathname)) and import in both. Note middleware runs on the edge a… | S | 低 |
| `duplicated-i18n-init` | 低 | duplication | The resourcesToBackend dynamic-import lambda and the initReactI18next init chain are duplicated in server.ts (createInstance per request) and client.tsx (singleton). The backend… | Extract the resourcesToBackend(...) backend into a shared factory exported from a common module and reuse in both server and client init. Low priority. | S | 低 |
| `orphan-key-main-showall` | 低 | dead-code | main.showAll ('Show All' / 'すべて表示') is defined in en/main.json and ja/main.json but never referenced anywhere in src (no t("main:showAll") or showAll string usage). | Remove the showAll key from both locale files, or wire it up if a 'show all' control was intended. | S | 低 |
| `orphan-api-error-keys` | 低 | dead-code | api-errors.json (en+ja) defines disallowedContentType and disposableEmailAddressesAreNotAccepted, but no error code in errorCodes maps to them and no code references the strings… | Either add corresponding entries to errorCodes and use them where appropriate (content-type / disposable-email validation), or remove the keys. Coordinate wi… | S | 低 |
| `untyped-lang-into-gettranslation` | 低 | risky-pattern | getTranslation is typed to accept AvailableLanguage, but layout.tsx passes params.lang typed as plain string, unvalidated. An unexpected [lang] segment (e.g. a crawler hitting /… | Validate lang against availableLanguages at the layout/page boundary (coerce unknown values to defaultLanguage) so i18next and the OGP image path always rece… | S | 低 |

### DEAD CODE & UNUSED DEPENDENCIES

Knip-style analysis (verified with two independent methods: zero-inbound-imports and unreachable-from-Next-entrypoints, which agree exactly) found 4 fully dead, git-tracked source files (443 LOC) and 4 removable npm dependencies, all centered on shadcn UI scaffolding that was generated but never wired up, plus better-auth migration leftovers. The dead surface is small but clean to remove with near-zero risk because none of it is reachable from any route or external (desktop-app) API. Two reconnaissance claims are wrong and should be dropped: no build artifacts are committed (.gitignore covers tsconfig.tsbuildinfo/.next/.open-next/.vercel/.wrangler), and there is no flat ESLint config — only a legacy .eslintrc.json exists alongside biome.json. The remaining findings are over-exported-but-not-dead symbols (low value) and empty untracked local directories.

| ID | 重要度 | 種別 | 内容 | 推奨対応 | 工数 | リスク |
|----|:---:|------|------|---------|:--:|:--:|
| `dead-ui-form-tsx` | 中 | dead-code | The shadcn react-hook-form wrapper (FormField, FormItem, FormControl, FormMessage, FormLabel, FormDescription, useFormField, Form) is imported by zero files. It is the ONLY file… | Delete src/components/ui/form.tsx. Then remove react-hook-form and @hookform/resolvers from package.json dependencies. (@radix-ui/react-label and @radix-ui/r… | S | 低 |
| `dead-ui-drawer-tsx` | 中 | dead-code | This is the shadcn vaul Drawer component (Drawer, DrawerTrigger, DrawerContent, DrawerHeader, DrawerFooter, DrawerTitle, DrawerDescription, DrawerClose, DrawerOverlay, DrawerPor… | Delete src/components/ui/drawer.tsx and remove vaul from package.json dependencies. | S | 低 |
| `dead-ui-tabs-tsx` | 中 | dead-code | The shadcn Tabs component (Tabs, TabsList, TabsTrigger, TabsContent) is imported nowhere and no <Tabs>/TabsList/TabsContent JSX exists anywhere else in src. @radix-ui/react-tabs… | Delete src/components/ui/tabs.tsx and remove @radix-ui/react-tabs from package.json dependencies. | S | 低 |
| `dead-lib-api-types` | 中 | dead-code | Six exported response DTOs (ProfileResponse, SimplePackageResponse, PackageResponse, ReleaseResponse, AcquirePackageResponse, FileResponse) are referenced nowhere outside this f… | Delete src/lib/api/types.ts. If type-safety for the v3 API responses is desired later, regenerate from the Hono route handlers rather than maintaining this d… | S | 低 |
| `dead-passkey-fns` | 低 | legacy-debris | updatePasskeyUsedAt and findPasskeyByCredentialId are exported from src/lib/db/passkey.ts but called nowhere in the entire repo (including scripts/). The other three exports in … | Delete the updatePasskeyUsedAt and findPasskeyByCredentialId function bodies from src/lib/db/passkey.ts. Keep the other three exports. | S | 低 |
| `dead-fluid-css-module` | 低 | dead-code | fluid.module.css (26 lines, single .fluid class) is imported by no TS/TSX file. The other six CSS modules in src/styles each have at least one consumer; this is the only orphan. | Delete src/styles/fluid.module.css. | S | 低 |
| `recon-correction-no-committed-artifacts` | 低 | config-cruft | The reconnaissance brief states tsconfig.tsbuildinfo (3.7MB) is committed and that .vercel/.next/.open-next should not be tracked. Verified false: .gitignore already excludes *.… | No action needed for committed artifacts. Optionally the user can delete the local 3.7MB tsconfig.tsbuildinfo to reclaim disk, but it is not in the repo. Dro… | S | 低 |
| `empty-untracked-component-dirs` | 低 | config-cruft | Two empty directories exist under src/components (effects-demo/ and security/) with no files. They are NOT tracked by git (git stores no empty dirs), so they are pure local file… | Delete the two empty directories locally (`rmdir`). No git change results since they were never tracked. Low priority — cosmetic. | S | 低 |
| `over-exported-internal-symbols` | 低 | dead-code | Several exported symbols are referenced only inside their defining file, so the `export` keyword is unnecessary surface area (but the symbols themselves are live and used locall… | Optional low-priority cleanup: drop the `export` keyword on the genuinely file-local symbols (renderUnsafeEmailTemplate, getUserIdFromHeaders, errorCodes, Ap… | M | 低 |
| `recon-correction-no-flat-eslint` | 低 | config-cruft | The reconnaissance brief lists three lint configs (.eslintrc.json + 'ESLint flat (eslint-config-next)' + biome.json). Verified: there is no eslint.config.* flat-config file on d… | No dead-config file to remove. If consolidating tooling, that is an inconsistency-dimension decision (pick Biome or ESLint). For this dimension: no action. | S | 低 |

### CONFIG & BUILD CRUFT

The toolchain carries three mutually contradictory deploy stories layered on top of each other: the live target is Cloudflare via @opennextjs/cloudflare (package.json scripts, wrangler.jsonc, open-next.config.ts), yet .github/workflows/ci.yml still deploys to Vercel, .github/workflows/deploy.yml SSH/SCPs a standalone Next build to a self-hosted systemctl server, and a committed-on-disk .vercel/ folder (with a real S3 secret in an untracked env file) is a stale artifact of the Vercel era. Lint/format tooling is also tripled (legacy .eslintrc.json + eslint-config-next + biome.json), but only `next lint` is ever invoked — Biome is installed and configured yet wired into no script or CI, and its config still uses Biome v1 schema/keys while v2.4.4 is installed. Secondary cruft: .env.sample is badly out of sync with the actual env vars (11 used-but-undocumented, 10 documented-but-unused), Node version is specified four different ways (20/22/24), the README is the untouched create-next-app boilerplate, and the cf-typegen script writes to a filename that doesn't match the hand-maintained worker-configuration.d.ts. None of these are committed secrets, but the divergence makes it impossible to tell from the repo how the app is actually built and shipped.

| ID | 重要度 | 種別 | 内容 | 推奨対応 | 工数 | リスク |
|----|:---:|------|------|---------|:--:|:--:|
| `triple-deploy-targets` | 高 | config-cruft | The repo encodes three incompatible deployment paths and only one is real. package.json scripts (deploy/preview/upload) use opennextjs-cloudflare and wrangler.jsonc/open-next.co… | Pick Cloudflare as the single target (it is what the code and bindings assume — src/prisma.ts and src/lib/storage.ts call getCloudflareContext). Delete .gith… | M | 低 |
| `stale-vercel-dir` | 高 | legacy-debris | .vercel/ is correctly gitignored (not tracked in git, verified via git ls-files), so this is NOT a committed-secret leak. However the directory still sits in the working tree fr… | Delete the entire .vercel/ directory from disk (`rm -rf .vercel`). If the S3 credentials in .env.development.local were ever pushed to Vercel and are still l… | S | 低 |
| `biome-unused-and-misconfigured` | 中 | inconsistency | Three lint/format tools coexist but only ESLint runs. @biomejs/biome 2.4.4 is a devDependency and biome.json enables its formatter+linter+organizeImports, yet no package.json sc… | Decide on ONE formatter/linter. Cleanest for a Next.js app: keep ESLint (eslint-config-next is required for Next's lint rules) and remove Biome entirely — dr… | M | 低 |
| `env-sample-drift` | 中 | inconsistency | .env.sample is meant to be the onboarding contract for required environment but it diverges from the code in both directions. The source reads 11 env vars that .env.sample never… | Rewrite .env.sample to match actual usage: add the 11 missing keys (with empty placeholder values + a comment for the JWT_* and BEUTL_*_VERSION groups), and … | S | 低 |
| `node-version-drift` | 低 | inconsistency | The required Node version is declared in four places that disagree, so local dev, CI, devcontainer, and the dead Vercel config can each run a different runtime. There is no `eng… | Pick one Node major (24, matching .nvmrc and the dev machine), add `"engines": { "node": ">=24" }` to package.json, bump the CI setup-node to read from .nvmr… | S | 低 |
| `cf-typegen-output-mismatch` | 低 | config-cruft | The `cf-typegen` script generates Cloudflare env types into cloudflare-env.d.ts, but that file does not exist on disk and is not referenced anywhere. The actual Cloudflare env t… | Make the script and the committed file agree: either rename the cf-typegen output to worker-configuration.d.ts and regenerate it from wrangler.jsonc (so it s… | S | 低 |
| `boilerplate-readme` | 低 | legacy-debris | README.md is the verbatim create-next-app template — it tells contributors to deploy on Vercel and references `app/page.tsx` and the Geist font, none of which reflect this marke… | Replace with a short real README: what the app is (Beutl marketplace/store), how to run it (pnpm install, env setup pointing at .env.sample, pnpm dev), and t… | S | 低 |
| `next-lint-deprecation` | 低 | risky-pattern | The only lint command is `next lint`, which Next.js has deprecated and is removing in Next 16 in favor of invoking ESLint directly. On the next major upgrade this script silentl… | Migrate to direct ESLint invocation (`eslint .`) with a single flat eslint.config.mjs that extends eslint-config-next, and delete .eslintrc.json. Do this tog… | S | 低 |

### Type Safety & Error Handling Patterns

The codebase has a small, well-defined error vocabulary for the desktop-facing API (lib/api/error.ts) with consistent .onError boundaries on the Hono v1/v3 routes, but the patterns degrade sharply outside that surface. There is one genuine production bug: a missing `await` in the v3 app-update endpoint returns an empty JSON error body to desktop clients. Server actions have no shared error/return-type convention - three different return shapes (`State`, locally-shadowed `Response`, and ad-hoc `{error?}`/`{message?}` objects) coexist, the auth guard offers both throwing and returning variants used inconsistently in the same files, and untyped action returns force `as any` casts at three call sites. Secondary issues include PII (raw IP/country) logged to console on every store render, several empty/swallowing catch blocks, and pervasive `as string` env-var casts that hide missing-config crashes. Most fixes are low-risk and local; the action-return-type unification is the highest-value structural cleanup.

| ID | 重要度 | 種別 | 内容 | 推奨対応 | 工数 | リスク |
|----|:---:|------|------|---------|:--:|:--:|
| `missing-await-apierror-v3-app` | 高 | risky-pattern | In the v3 /app update endpoint, the 'asset not found' branch calls c.json(apiErrorResponse("assetNotFound"), {status:404}) WITHOUT awaiting. apiErrorResponse is async and return… | Add the missing await: `return c.json(await apiErrorResponse("assetNotFound"), { status: 404 });`. To prevent recurrence, enable @typescript-eslint/no-floati… | S | 低 |
| `errorcodes-numeric-values-dead` | 中 | dead-code | errorCodes maps 30 names to integers (unknown:0 ... cannotDeleteReleaseAssets:29), implying a numeric wire protocol. But apiErrorResponse sets error_code to the KEY string (erro… | Pick one representation. If the desktop app reads the string key (verify against the client), convert errorCodes to a plain string-literal union or string en… | S | 低 |
| `action-return-types-untyped-as-any` | 中 | risky-pattern | updateRelease and createRelease have no explicit return type. Their success branch returns `{ success: true, data: <db row> }` but their failure branches return `{ success: fals… | Define a shared discriminated result type, e.g. `type ActionResult<T=void> = { success: true; data: T } / { success: false; message?: string; errors?: Record… | M | 低 |
| `response-type-shadows-dom` | 中 | inconsistency | Two server-action modules declare `type Response = { success: boolean; message?: string }` and then annotate functions as `Promise<Response>` while returning plain objects (some… | Rename to a non-shadowing name (ActionResult) or replace with the shared discriminated ActionResult type from the previous finding. Never name a local type R… | S | 低 |
| `auth-guard-inconsistent-throw-vs-return` | 中 | inconsistency | lib/auth-guard.ts provides three overlapping guards: authOrSignIn (redirects), authenticated (wraps a callback and returns {message:'Unauthenticated', success:false} on failure)… | Standardize on one failure contract for non-redirect actions (prefer returning the discriminated ActionResult error rather than throwing, so useActionState/h… | M | 低 |
| `pii-ip-logging-currency` | 高 | risky-pattern | guessCurrency() runs on store/checkout rendering and unconditionally console.log's the visitor's IP address, resolved country, and currency. This is not gated by NODE_ENV (only … | Delete all three console.log calls. If currency-resolution diagnostics are needed, log only the resolved currency code (never the IP) behind a debug flag or … | S | 低 |
| `stripe-webhook-no-error-boundary` | 中 | risky-pattern | The Stripe webhook POST handler calls stripe.webhooks.constructEvent() and then performs multiple un-wrapped DB writes (userPackage.create, createUserPaymentHistory, addAuditLog… | Wrap constructEvent in try/catch and return 400 on signature failure with a clear message; wrap the handler body so DB errors return a 500 that Stripe will r… | M | 中 |
| `swallowed-catch-blocks` | 中 | risky-pattern | Multiple catch blocks discard the caught error entirely, making failures invisible. The most consequential is security/page.tsx:46 `catch {}` around a GitHub API fetch used to r… | Log the caught error (structured logger) before swallowing in the server-side GitHub-fetch and token-decrypt cases so failures are diagnosable; keep the user… | M | 低 |
| `any-typed-status-and-currency-maps` | 低 | risky-pattern | Two lookup tables are typed `any`, discarding type checking on both keys and values. STATUS_CONTENT_MAP: any in the checkout-complete component indexes by Stripe.PaymentIntent['… | Type STATUS_CONTENT_MAP as Record<string, {title; text; icon}> with a default fallback and have getStatusContent return STATUS_CONTENT_MAP[status] ?? STATUS_… | S | 低 |
| `env-var-as-string-casts` | 低 | risky-pattern | Required secrets/config are read as `process.env.NAME as string` in ~12 places (JWT_SECRET, STRIPE_ENDPOINT_SECRET, AUTH_* OAuth secrets, AUTH_RESEND_KEY, BEUTL_LATEST/REQUIRED_… | Validate environment once at module load with a schema (e.g. a small env.ts using zod) that throws a descriptive error naming the missing variable, and impor… | M | 低 |
| `console-as-error-channel` | 低 | inconsistency | All 17 console.* calls are the de facto logging strategy: the Hono .onError handlers (v1/v3 route.ts) console.error the error, server actions console.error validation failures a… | Introduce one thin logging module (even a wrapper over console with level + context fields) and route .onError and action error paths through it with context… | M | 低 |

### DB Schema & Migrations

The schema (22 models, 4 enums, 300 lines) is lean and almost every model/field is reachable from src/ — there is little dead schema and the previously-flagged Compat* models were already cleanly removed (commit 09a1548) with no leftover sequences or columns, and no Drizzle artifacts remain in the DB layer after the revert. The real debris is a three-way database-provider mismatch: the Prisma datasource and migration_lock are declared `cockroachdb` (migrations emit Cockroach-flavored SQL: STRING/INT4/current_timestamp()), the runtime connects via `@prisma/adapter-pg` to a Postgres Hyperdrive, and the better-auth adapter is configured `provider: "postgresql"` — three sources of truth that disagree about the database engine. Secondary issues are a total absence of secondary indexes on heavily-filtered foreign-key/scan columns, type churn between BigInt and Int that has settled but left mixed BigInt-vs-number handling, and a few naming/convention leftovers from the NextAuth-to-better-auth migration (constraint name `Session_sessionToken_key`, `authjs.*` audit action keys, inconsistent `@default(now()) @updatedAt`).

| ID | 重要度 | 種別 | 内容 | 推奨対応 | 工数 | リスク |
|----|:---:|------|------|---------|:--:|:--:|
| `provider-mismatch-cockroach-vs-postgres` | 高 | inconsistency | The database engine is declared three different ways across the stack. prisma/schema.prisma datasource is `provider = "cockroachdb"` and prisma/migrations/migration_lock.toml is… | Pick one engine and align all three. Given the runtime uses adapter-pg against a Postgres Hyperdrive, switch the schema datasource and migration_lock to `pro… | M | 中 |
| `no-secondary-indexes` | 中 | missing-abstraction | The schema declares no secondary indexes at all (grep `@@index` = 0). Only primary keys and uniques are indexed. In Postgres/CockroachDB, foreign-key columns are NOT auto-indexe… | Add @@index on the FK columns actually filtered/joined (File.userId, Package.userId, Release.packageId, UserPackage.packageId, UserPaymentHistory.userId, Aud… | M | 低 |
| `bigint-int-churn-residue` | 低 | legacy-debris | The price/order fields flip-flopped across at least four commits (73269bb, f89d423, e95bbaf, then the bigint_to_int migration) before settling on Int — that history is now consi… | Decide whether File.size needs BigInt at all (max practical upload size fits in Int4/Int8-as-number). If BigInt is kept, type the createFile input as `number… | S | 低 |
| `nextauth-naming-leftovers` | 低 | legacy-debris | The NextAuth->better-auth migration left cosmetic naming debris. The Session model's token column carries an explicit constraint-name map preserving the old NextAuth column name… | Drop the `map:` override so the constraint name regenerates to the canonical `Session_token_key` (requires a rename migration), and rename the `authjs` audit… | S | 低 |
| `updatedat-convention-inconsistency` | 低 | inconsistency | The updatedAt convention is applied two different ways. Account, Session-adjacent Verification, and a couple others declare `@default(now()) @updatedAt` while the rest of the mo… | Standardize on one form. Since Prisma populates @updatedAt at create regardless, drop the redundant `@default(now())` from Account/Verification (or, if you p… | S | 低 |
| `verification-unique-constraint-lost-in-squash` | 低 | legacy-debris | Commit c8929b8 (Feb 25) explicitly 'add unique constraint to Verification identifier' and removed 3 lines from better-auth.ts that presumably worked around its absence. The late… | Confirm the intended invariant (better-auth wants NO unique on Verification.identifier — current state is correct) and add a brief comment or commit note so … | S | 低 |

### Routing Structure & Layout Duplication

The [lang] route tree has seven route groups but inconsistent use of layout.tsx. Four group layouts ((store), (developer), (storage), (docs)/docs) are byte-for-byte near-identical NavBar wrappers that differ only by an optional Footer; meanwhile (main) and (auth-flow) have NO layout, forcing NavBar/Footer and a logo-card-chrome to be copy-pasted inline across pages. The biggest concrete waste is the auth-flow "centered card + logo header + privacy-link footer" wrapper duplicated verbatim in 5 files. SEO/UX boundaries are entirely absent: only the root layout declares metadata (no per-page titles for store/package/publisher pages), and there are zero loading.tsx/error.tsx/not-found.tsx files in the whole app. Two empty developer route directories (earnings, settings) are dead scaffolding.

| ID | 重要度 | 種別 | 内容 | 推奨対応 | 工数 | リスク |
|----|:---:|------|------|---------|:--:|:--:|
| `identical-navbar-layouts` | 中 | duplication | The layout.tsx files for (store), (developer), and (storage) are byte-for-byte identical: they import NavBar, await params for lang, destructure children, and render <div><NavBa… | Extract a single shared layout component, e.g. components/page-shell.tsx accepting `{lang, children, footer?: boolean}`, and have each group layout be a 3-li… | S | 低 |
| `auth-flow-missing-layout` | 高 | missing-abstraction | There is no src/app/[lang]/(auth-flow)/layout.tsx. As a result the identical visual chrome -- a full-screen centered container (`h-screen flex items-center justify-center`), an … | Create src/app/[lang]/(auth-flow)/layout.tsx (or an account/ sub-layout) rendering the centered container, logo header, and privacy link once, with {children… | M | 中 |
| `main-group-no-layout-inline-chrome` | 中 | inconsistency | Unlike the four groups that use a NavBar layout, the (main) group has no layout.tsx, so the landing page and feedback page each import and render <NavBar lang={lang}/> ... <Foot… | Add src/app/[lang]/(main)/layout.tsx rendering NavBar + Footer around children (matching the (docs)/docs layout), and remove the inline NavBar/Footer from pa… | S | 低 |
| `no-loading-error-boundaries` | 中 | missing-abstraction | The app has no loading, error, or not-found boundaries anywhere. Several pages do real async work (store/[name], billing fetches Stripe + DB in a Promise.all, library, developer… | Add at minimum a root error.tsx and not-found.tsx under src/app/[lang]/, plus loading.tsx for the heaviest segments ((store)/store, (store)/store/[name]/chec… | M | 低 |
| `empty-developer-route-dirs` | 低 | dead-code | src/app/[lang]/(developer)/developer/earnings/ and .../settings/ exist as directories with NO page.tsx/route.ts/layout.tsx -- they are empty dead scaffolding that produce no rou… | Delete the two empty directories. If earnings/settings are planned, track them in an issue rather than leaving empty dirs committed. No route or import refer… | S | 低 |
| `no-per-page-metadata` | 中 | missing-abstraction | generateMetadata/export const metadata appears exactly once in the entire route tree (root layout), which hardcodes title 'Beutl' and the main:description for every page. Public… | Add generateMetadata to the dynamic public pages -- at least store/[name] (package displayName + shortDescription + icon as OG image) and publishers/[name] -… | M | 低 |
| `duplicated-session-redirect-guard` | 中 | duplication | A reusable guard authOrSignIn() already exists in lib/auth-guard.ts (gets session, redirects to /account/sign-in?returnUrl=... on miss). Yet multiple route files reimplement tha… | Replace the hand-rolled session-check/redirect blocks in the manage layout and account pages with authOrSignIn() (or a variant that returns the session for t… | M | 中 |
| `about-vs-docs-redirect-stubs` | 低 | legacy-debris | Under (docs) there are two parallel locations for the same content: about/privacy and about/telemetry are 11-line files that simply redirect to docs/privacy and docs/telemetry r… | Keep them only if external/desktop clients still link to /about/privacy and /about/telemetry (verify against the desktop app); otherwise delete. If kept, con… | S | 中 |

### STYLING & ASSETS

The styling layer is small and mostly coherent (Tailwind v4 via @tailwindcss/postcss, shadcn components, 7 CSS modules for landing-page animations, cn() helper), and 6 of the 7 CSS modules are genuinely in use. The real waste sits in three buckets: dead font assets (two Geist woff files plus a font CSS-variable wiring that is set but never consumed by any font-family), unused image assets in public/img (~6 files, including two ~700KB brand-image variants), and dead CSS inside globals.css (a fully commented-out duplicate theme palette, a never-applied light-mode :root palette since the app is hardcoded dark-only, three unused @utility definitions, and unused chart color tokens). None of these touch the external desktop-app API clients, so refactor risk is uniformly low; the main caution is confirming an image isn't referenced by the desktop app or email templates before deleting.

| ID | 重要度 | 種別 | 内容 | 推奨対応 | 工数 | リスク |
|----|:---:|------|------|---------|:--:|:--:|
| `dead-geist-fonts` | 中 | dead-code | src/app/fonts/ contains GeistVF.woff (66KB) and GeistMonoVF.woff (68KB), both committed to git, but nothing imports them. The app loads fonts exclusively via Noto_Sans_JP from n… | Delete src/app/fonts/ (both woff files). They are leftover from the original create-next-app scaffold (the standard Next.js template ships exactly these two … | S | 低 |
| `noto-font-variable-not-wired` | 低 | config-cruft | layout.tsx configures Noto_Sans_JP with variable: '--font-noto-sans-jp' and applies notoSansJP.variable to the body className, but that CSS variable is never referenced by any f… | Either wire it up (add --font-sans: var(--font-noto-sans-jp) inside @theme in globals.css and use the font's className instead of variable), or drop the vari… | S | 低 |
| `unused-public-images` | 中 | dead-code | Cross-referencing every /img/ string in src (and the beditor.net/img URLs in resend.ts email templates) against public/img reveals 6 image files with zero references. brand-imag… | Delete the 6 unreferenced files, prioritizing brand-image.png (736KB). Before deleting, confirm none are linked by the Beutl desktop app or external pages by… | S | 中 |
| `fluid-module-unused` | 低 | dead-code | src/styles/fluid.module.css (a 'morph' border-radius animation) has zero imports anywhere in src. Separately, src/components/effects-demo/ is an empty directory (the actual comp… | Delete src/styles/fluid.module.css and remove the empty src/components/effects-demo/ directory. | S | 低 |
| `globals-commented-theme-block` | 低 | legacy-debris | globals.css contains two big commented-out blocks: lines 70-87 (an old :root + prefers-color-scheme + body font-family) and lines 112-197 (an entire alternate @layer base palett… | Delete both commented blocks. They are pure noise and the duplicated .dark inside the comment (which itself redefines --background twice) makes the file hard… | S | 低 |
| `dead-light-mode-palette` | 低 | dead-code | globals.css defines a full :root light-mode palette (lines 199-229) and a .dark palette (lines 231-259), but <html> is hardcoded to className="dark" in layout.tsx with no theme … | Decide intent. If dark-only is permanent, remove the :root light palette (lines 199-229) and the @custom-variant/dark: scaffolding, simplifying to a single p… | M | 低 |
| `unused-custom-utilities` | 低 | dead-code | globals.css defines four custom @utility helpers; three of them are never applied as classes anywhere: text-balance (line 89), glow-primary (line 102), and glass (line 106). Onl… | Remove the text-balance, glow-primary, and glass @utility blocks from globals.css. Keep hidden-scrollbar. | S | 低 |
| `unused-chart-color-tokens` | 低 | dead-code | globals.css @theme maps --color-chart-1 through --color-chart-5 to hsl(var(--chart-N)) (lines 35-39), but the underlying --chart-N variables are only defined inside the commente… | Remove the five --color-chart-* mappings from the @theme block. They resolve to undefined variables and are never referenced. | S | 低 |
| `orphan-shimmer-class` | 低 | dead-code | hero-gradient.module.css references .shimmer only inside the prefers-reduced-motion block (to disable its animation), but .shimmer is never defined as an actual style nor applie… | Remove .shimmer from the prefers-reduced-motion selector list in hero-gradient.module.css. | S | 低 |
| `wordwrap-inline-repetition` | 低 | inconsistency | The same inline style style={{ wordWrap: 'break-word' }} is duplicated in 4 places across 3 files, mixing inline-style with the otherwise Tailwind-based approach. Tailwind alrea… | Replace the four inline styles with the Tailwind utility className 'break-words' for consistency. (The other inline styles in the codebase are dynamic values… | S | 低 |
| `headers-file-platform-mismatch` | 低 | config-cruft | public/_headers sets long-lived immutable caching for /_next/static/*. The _headers file is a Cloudflare Pages convention; this project deploys via @opennextjs/cloudflare to Wor… | Verify whether the Workers/OpenNext setup actually honors public/_headers. If not, move the immutable cache header into the proper place (Workers assets conf… | S | 低 |
