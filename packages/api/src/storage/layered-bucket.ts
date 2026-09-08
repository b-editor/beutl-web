// プロバイダを切り替えた後も、切り替え前に保存したオブジェクトをそのまま読める
// ようにする層。新しいオブジェクトは primary にだけ書き、primary に無いものは
// fallback を見に行く。キーは UUID 由来で両者に重複しないので、どちらで見つかった
// かに曖昧さは無い。削除は両方に出す (どちらも無いキーの削除は成功扱いなので安全)。
import type { R2BucketLike } from "../ai/r2-provider";
import { isTerminalMultipartAbortError } from "./multipart-errors";

type MultipartHandle = ReturnType<
  NonNullable<R2BucketLike["resumeMultipartUpload"]>
>;

export function createLayeredBucket({
  primary,
  fallback,
}: {
  primary: R2BucketLike;
  fallback: R2BucketLike;
}): R2BucketLike {
  const bucket: R2BucketLike = {
    put: (key, value, options) => primary.put(key, value, options),
  };

  if (primary.get) {
    const read = primary.get.bind(primary);
    bucket.get = async (key) => {
      const found = await read(key);
      if (found !== null || !fallback.get) return found;
      return await fallback.get(key);
    };
  }

  if (primary.head) {
    const inspect = primary.head.bind(primary);
    bucket.head = async (key) => {
      const found = await inspect(key);
      if (found !== null || !fallback.head) return found;
      return await fallback.head(key);
    };
  }

  if (primary.delete) {
    const remove = primary.delete.bind(primary);
    bucket.delete = async (key) => {
      await remove(key);
      if (fallback.delete) await fallback.delete(key);
    };
  }

  if (primary.createMultipartUpload) {
    const create = primary.createMultipartUpload.bind(primary);
    bucket.createMultipartUpload = (key, options) => create(key, options);
  }

  if (primary.resumeMultipartUpload) {
    const resume = primary.resumeMultipartUpload.bind(primary);
    bucket.resumeMultipartUpload = (key, uploadId): MultipartHandle => {
      const first = resume(key, uploadId);
      const second = fallback.resumeMultipartUpload?.(key, uploadId);
      if (!second) return first;
      // An upload id the primary has never heard of belongs to a handle that
      // was opened before the switch. Only the calls without a body can be
      // repeated against the fallback: a part's stream is consumed by the
      // first attempt, so a stale handle fails its next part and the client
      // starts over on the primary.
      const orFallback = async <T>(
        run: (handle: MultipartHandle) => Promise<T>,
      ): Promise<T> => {
        try {
          return await run(first);
        } catch (error) {
          if (!isTerminalMultipartAbortError(error)) throw error;
          try {
            return await run(second);
          } catch (fallbackError) {
            throw isTerminalMultipartAbortError(fallbackError) ? error : fallbackError;
          }
        }
      };
      return {
        uploadPart: (partNumber, value, options) =>
          first.uploadPart(partNumber, value, options),
        complete: (parts) => orFallback((handle) => handle.complete(parts)),
        abort: () => orFallback((handle) => handle.abort()),
      };
    };
  }

  return bucket;
}
