# ADR 0003: Forgejo をヘッドレスで置き、beutl-web が代理操作する

## Status

Accepted

## Context

Beutl のプロジェクトはディレクトリ構造で、`.bep` / `.scene` / `.belm` はいずれも
`Beutl.Core/JsonHelper.cs` が `WriteIndented = true` で書き出す整形済み JSON になる。
行単位の差分がそのまま意味を持つので Git と相性が良い一方、素材 (動画・音声・画像・
フォント) は巨大なバイナリで、通常の Git オブジェクトに入れると破綻する。

そこで Beutl のプロジェクト管理基盤として Git サービスを自前で持つことにした。
サーバーは Forgejo をセルフホストする (別リポジトリ `git-server`)。素材は Git LFS に載せ、
その振り分けはリポジトリ作成時に置く `.gitattributes` が担う。

決めるべきだったのは「ユーザーが Forgejo とどう関わるか」だった。

## Decision

**Forgejo の Web UI は一般ユーザーに公開しない。** ユーザー向けの画面は beutl-web だけに
置き、Forgejo は git バックエンドと API に徹する。リポジトリは当面すべて非公開。

この選択から、以下が決まる。

### 1. SSO (OIDC) は入れない

ユーザーが Forgejo に対話ログインしないので、Better Auth を OIDC プロバイダにする必要がない。
`better-auth@1.6.26` には `better-auth/plugins/oidc-provider` があるが (1.7 で
`@better-auth/oauth-provider` へ置換される)、導入すると Prisma に 3 テーブル追加・JWKS 運用・
同意画面が必要になる。ヘッドレス構成ではその全部が不要になる。

将来 Forgejo の UI を公開する判断をしたときに、改めて OIDC 化を検討する。

### 2. beutl-web は管理トークン + `Sudo` ヘッダで代理操作する

`packages/forgejo` が唯一の窓口になる。サイト管理者のアクセストークンで認証し、
`Sudo: <forgejoUsername>` を付けて対象ユーザーとして実行する。こうすると Forgejo 側が
そのユーザーの権限で判定するため、他人の非公開リポジトリは 404 になる。

Caddy は `/api/v1/*` に共有シークレットヘッダ (`X-Beutl-Proxy-Secret`) の一致を要求する。
管理トークンが漏れても壁がもう一枚残る。定数時間比較ではないので、単独の認証手段ではなく
多層防御の 1 枚として扱う。

### 3. Beutl アカウントと Forgejo ユーザーの対応表を持つ

`GitAccount` (userId ↔ forgejoUserId / forgejoUsername)。Forgejo 側のユーザーは
beutl-web が管理 API で作る。ユーザー名は `Profile.userName` を Forgejo の規則に正規化して
採番し、衝突したら連番を足す。最終的な一意性の判定は Forgejo に委ねる
(`POST /admin/users` の 422 を見て次の候補に進む)。

メールアドレスは Forgejo が一意性を要求するので、実アドレスは渡さず
`<userId>@users.noreply.<host>` を合成する。

### 4. git 用トークンは「使い捨てパスワード経由」で発行する

デスクトップは git over HTTPS の Basic 認証にアクセストークンを使う。ところが Forgejo の
トークン管理エンドポイント (`/api/v1/users/{username}/tokens`) は **トークン認証も `Sudo`
代理も受け付けず**、対象ユーザー自身の Basic 認証だけを許す (`auth method not allowed`)。

そのため発行・失効は次の順で行う。

1. `PATCH /api/v1/admin/users/{username}` で使い捨てのランダムパスワードを設定する
   (`source_id` と `login_name` を必ず含める。欠けると 422)
2. そのパスワードで Basic 認証し、`/api/v1/users/{username}/tokens` を叩く
3. パスワードは保存せず捨てる

ユーザーは Forgejo に対話ログインしないので、パスワードが毎回変わっても誰も困らない。
**パスワードを変えても発行済みのトークンは失効しない**ことは実機で確認済みで、
この方式なら beutl-web 側に長期保存する資格情報が 1 つも増えない。

### 5. トークンは端末ごとに 1 本持てる

トークンを 1 本に固定すると、ある端末で発行した瞬間に他の端末の資格情報が切れる。
Forgejo は名前が違えば何本でも保持できる (実機で確認済み) ので、端末名をラベルにして
複数本を並存させる。失効は 1 本ずつで、他の端末には影響しない。

一覧表示のためだけに Forgejo へ問い合わせるとパスワードの振り直しが要るので、
表示に必要なメタ情報 (ラベル・トークン id・末尾 8 文字・発行日) は `GitCredential` に控える。
Forgejo を触るのは発行と失効のときだけ。平文は控えない。

失効は名前ではなく Forgejo 側のトークン id で行う。Forgejo はトークン名に空白や
スラッシュを許すため、名前を URL パスに載せる形は避ける。

歯止めとして、ラベルは 50 文字まで (Forgejo は 255 文字を超えると 422 ではなく 500 を返す)、
1 ユーザーあたり 20 本までとしている。

#### 控えと Forgejo がずれた場合

`GitCredential` は Forgejo と自動同期しない。運用者が Forgejo 側でトークンを直接
削除すると、控えだけが残る。そのとき起きることは 2 つで、どちらも致命的ではない。

- 一覧に使えないトークンが並ぶ
- 20 本の上限判定がその分厳しくなる

回復はダッシュボードで失効を押すだけでよい。失効は Forgejo の 404 を許容して控えを
消すので、通常の操作がそのまま片付けになる。逆向きのずれ (Forgejo にあって控えに無い)
は、beutl-web 以外がトークンを作らない限り起きない。

#### 同時操作

発行と失効はどちらも使い捨てパスワードを設定してから Basic 認証する。同じユーザーが
2 つの操作を同時に走らせると、後から設定されたパスワードで先の操作が 401 になる。
その場合はパスワードを引き直して最大 3 回までやり直す。

## Consequences

- Forgejo が持つ Issue / Pull Request / コードレビューは使えない。必要になったら
  beutl-web 側で作るか、UI 公開の判断をやり直すことになる。
- `FORGEJO_ADMIN_TOKEN` はサイト全体の管理権限を持つ。漏洩の影響が大きいので
  `wrangler secret` に置き、Caddy 側の共有シークレットと併用する。
- Forgejo の API には `size` という名前のフィールドが 2 つあり、意味が違う。混同しやすい。

  | どこ | 意味 |
  | --- | --- |
  | リポジトリ (`/repos/{owner}/{repo}`) の `size` | KiB 単位。リポジトリ本体 **と LFS の合計**。保存先が S3 でも変わらない |
  | contents API のエントリの `size` | バイト単位。LFS 管理下のファイルでは**ポインタ自身**の大きさ (百数十バイト) |

  一覧画面の合計容量は前者を使い、ファイルごとのサイズは後者なので `resolveContentSizes` が
  小さいファイルだけ中身を読んで実サイズに直す。判定はサイズだけで行い拡張子は見ないので、
  アイコンの対応表に漏れがあってもサイズ表示には影響しない。読みに行く件数には上限があり、
  超えた分はサイズを表示しない (誤った数字を出すより黙る)。

## Desktop contract

Beutl 本体の Git クライアントは `/api/v3/git/*` を使う。認証は v1 が発行する JWT
([ADR 0001](0001-v1-account-is-the-auth-backbone.md)) をそのまま使う。

| エンドポイント | 用途 |
| --- | --- |
| `GET /api/v3/git/account` | Forgejo ユーザー名とベース URL |
| `GET /api/v3/git/credentials` | 発行済みトークンの一覧 (平文は含まない) |
| `POST /api/v3/git/credentials` | トークンを 1 本発行。`{"deviceName": "..."}` が必須 |
| `DELETE /api/v3/git/credentials/{id}` | そのトークンだけを失効させる |
| `GET /api/v3/git/repositories` | リポジトリ一覧 |
| `POST /api/v3/git/repositories` | リポジトリ作成 (`.gitattributes` 込みで初期化) |

`deviceName` を必須にしているのは、省略できると起動のたびに発行するクライアントが
トークンを際限なく積み上げてしまうため。同じ名前で 2 本目を作ろうとすると 409 を返すので、
クライアントは端末ごとに安定した名前を送り、409 なら既存のものを使い回すか失効させる。

git 本体の通信 (clone / fetch / push / LFS) はこの API を通らず、Forgejo に直接 HTTPS で繋ぐ。
この API が渡すのは接続先と資格情報だけ。
