// 1 ユーザーあたりのストレージ上限。DB には持たせておらず、アップロード時の判定と
// 使用量表示の分母がこの 1 つの値を共有する。
export const STORAGE_QUOTA_BYTES = 1024 * 1024 * 1024;

// 1 パートの大きさ。Cloudflare Workers はリクエストボディを 100MB で打ち切るので、
// それより十分小さく取る。R2 は最後以外のパートに 5MiB 以上・同じ大きさを求める
// ため、この値が全パート共通の大きさになる (最後だけ端数)。
//
// 16MiB なら上限いっぱいの 1GiB でも 64 リクエストで済み、1 つ失敗しても
// やり直しは 16MiB で済む。
export const STORAGE_UPLOAD_PART_BYTES = 16 * 1024 * 1024;

// 1 ユーザーあたりのファイル数の上限。容量だけでは本数を縛れない——1 バイトの
// ファイルを順に完成させれば、1GiB の枠の内側で R2 のオブジェクトと DB の行を
// 際限なく増やせる。増えて困るのは容量ではなくその数のほうなので、別に限る。
export const STORAGE_FILE_COUNT_LIMIT = 10_000;

// ファイル名の上限。R2 のキーではなく表示名なので、Content-Disposition に収まる長さで足りる。
export const STORAGE_FILE_NAME_MAX_LENGTH = 255;
