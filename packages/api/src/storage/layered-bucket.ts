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
      if (!fallback.delete) {
        await remove(key);
        return;
      }
      // Both deletes always run: an unreachable primary must not leave the
      // fallback's copy behind, and deleting a missing key succeeds anyway.
      const results = await Promise.allSettled([remove(key), fallback.delete(key)]);
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
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
      // Some services answer an abort for an id they never issued with a
      // plain success (MinIO does), which would hide the stale handle in the
      // other store. Abort reaches both stores; it succeeds when either one
      // still knew the upload, and reports the primary's error when neither.
      const abortBoth = async (): Promise<void> => {
        const [viaPrimary, viaFallback] = await Promise.allSettled([first.abort(), second.abort()]);
        for (const result of [viaPrimary, viaFallback]) {
          if (result.status === "rejected" && !isTerminalMultipartAbortError(result.reason)) {
            throw result.reason;
          }
        }
        if (viaPrimary.status === "fulfilled" || viaFallback.status === "fulfilled") return;
        throw viaPrimary.reason;
      };
      return {
        uploadPart: (partNumber, value, options) =>
          first.uploadPart(partNumber, value, options),
        complete: (parts) => orFallback((handle) => handle.complete(parts)),
        abort: abortBoth,
      };
    };
  }

  return bucket;
}
