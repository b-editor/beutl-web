// 無料枠の 1 ユーザーあたりのストレージ上限。DB には持たせておらず、アップロード時の
// 判定と使用量表示の分母は、契約状態から解決した値 (storage-plan.ts) を使う。
// この定数は「契約が無いとき」の値。
export const STORAGE_FREE_QUOTA_BYTES = 1024 * 1024 * 1024;

// 1 パートの大きさ。Cloudflare Workers はリクエストボディを 100MB で打ち切るので、
// それより十分小さく取る。R2 は最後以外のパートに 5MiB 以上・同じ大きさを求める
// ため、この値が全パート共通の大きさになる (最後だけ端数)。
//
// 16MiB なら 1GiB でも 64 リクエストで済み、1 つ失敗してもやり直しは 16MiB で済む。
export const STORAGE_UPLOAD_PART_BYTES = 16 * 1024 * 1024;

// R2 のマルチパートアップロードが受け付けるパート数の上限。
export const STORAGE_MULTIPART_MAX_PARTS = 10_000;

// 1 ファイルの上限。パートの大きさを固定しているので、パート数の上限がそのまま
// ファイルの上限になる (16MiB × 10,000 = 160,000MiB、およそ 156GiB)。有料ティアの容量がこれより
// 大きくても、1 ファイルでこれを超えるものは受けない。
export const STORAGE_MAX_FILE_BYTES =
  STORAGE_MULTIPART_MAX_PARTS * STORAGE_UPLOAD_PART_BYTES;

// 無料枠の 1 ユーザーあたりのファイル数の上限。容量だけでは本数を縛れない——1 バイトの
// ファイルを順に完成させれば、容量の枠の内側で R2 のオブジェクトと DB の行を
// 際限なく増やせる。増えて困るのは容量ではなくその数のほうなので、別に限る。
export const STORAGE_FREE_FILE_COUNT_LIMIT = 10_000;

// 有料ティアのファイル数の上限。全ティア共通。
export const STORAGE_PAID_FILE_COUNT_LIMIT = 100_000;

// ファイル名の上限。R2 のキーではなく表示名なので、Content-Disposition に収まる長さで足りる。
export const STORAGE_FILE_NAME_MAX_LENGTH = 255;
