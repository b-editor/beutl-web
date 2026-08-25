import {
  aiScreenUploadLimit,
  MAX_AI_TRANSCRIPTION_UPLOAD_BYTES,
  MULTIPART_OVERHEAD_BYTES,
} from "./ai-capabilities";
import { STORAGE_UPLOAD_PART_BYTES } from "./storage-quota";

/**
 * 1 リクエストの本文に許す大きさ。
 *
 * next.config.mjs の `serverActions.bodySizeLimit` と同じ数——いちばん大きいもの、
 * パッケージの送信に合わせてある。二つに分かれているのは、あちらが Next の設定で
 * 文字列、こちらが Worker の入口で数だから。片方だけ動かすと、通ったものが次で
 * 断られる。
 */
export const MAX_REQUEST_BODY_BYTES = 100 * 1024 * 1024;

/**
 * API の Worker が 1 リクエストで受ける大きさ。
 *
 * ここに来るいちばん大きいものは、文字起こしの音声とアップロードの 1 かけら。
 * ページの Worker と違ってパッケージの送信は通らないので、その上限に付き合う
 * 理由がない——JSON しか読まない v1 の入口は、認証の前に本文を丸ごと解釈する
 * ので、外側で切っておく。
 */
export const MAX_API_REQUEST_BODY_BYTES =
  Math.max(MAX_AI_TRANSCRIPTION_UPLOAD_BYTES, STORAGE_UPLOAD_PART_BYTES)
  + MULTIPART_OVERHEAD_BYTES;

/**
 * そのパスの本文に許す大きさ。
 *
 * AI の画面には、その画面のファイルが来る量だけを許す。それ以外は全体の上限。
 *
 * **これは Server Action を選り分けない。** Action は URL ではなく Next-Action
 * ヘッダーの ID で選ばれるので、AI の Action は AI 以外のパスへも POST できる
 * ——そちらは全体の上限で受ける。ここが縮めるのは、その画面へ普通に送られてくる
 * ものの上限。
 */
export function requestBodyLimit(pathname: string): number {
  return aiScreenUploadLimit(pathname) ?? MAX_REQUEST_BODY_BYTES;
}

/**
 * 長さを名乗らない本文を、数えながら通す。上限を超えたところで切る。
 *
 * 名乗った長さは信じない——名乗らずに送ることも、名乗った以上に送ることもできる
 * ので、実際に流れたぶんを数える。切られた本文は下流で読めずに終わるが、抱えた
 * まま増え続けるよりはいい。
 */
export function boundedBody(
  body: ReadableStream<Uint8Array>,
  limit: number,
): ReadableStream<Uint8Array> {
  const source = body.getReader();
  let seen = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await source.read();
      } catch (error) {
        controller.error(error);
        return;
      }
      if (next.done) {
        controller.close();
        return;
      }

      seen += next.value.byteLength;
      if (seen > limit) {
        const error = new Error("Request body exceeds the configured limit");
        await source.cancel(error).catch(() => undefined);
        controller.error(error);
        return;
      }
      controller.enqueue(next.value);
    },
    async cancel(reason) {
      await source.cancel(reason).catch(() => undefined);
    },
  });
}
