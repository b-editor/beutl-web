import { Progress } from "@beutl/ui/ui/progress";
import { cn, formatBytes, STORAGE_QUOTA_BYTES } from "@beutl/core";
import { getTranslation } from "@beutl/i18n";

// 残りが 1 割を切ったら警告し、使い切ったら赤にする。
const WARNING_RATIO = 0.9;

// 一覧の脇に添える一行。数字を大きく見せる場所ではないので、細いバーと小さな
// 説明文だけにし、空きが少ないときだけ色と一文で目を引く。
export async function StorageUsage({
  lang,
  usedBytes,
  fileCount,
}: {
  lang: string;
  usedBytes: number;
  fileCount: number;
}) {
  const { t } = await getTranslation(lang);
  const ratio = Math.min(usedBytes / STORAGE_QUOTA_BYTES, 1);
  const remainingBytes = Math.max(STORAGE_QUOTA_BYTES - usedBytes, 0);
  const level = ratio >= 1 ? "full" : ratio >= WARNING_RATIO ? "warning" : "ok";
  const usage = t("storage:storageUsage", {
    used: formatBytes(usedBytes),
    quota: formatBytes(STORAGE_QUOTA_BYTES),
  });

  return (
    <div className="flex flex-col gap-1.5" aria-label={usage}>
      <Progress
        value={ratio * 100}
        max={100}
        className={cn(
          "h-1.5 max-w-xs",
          level === "warning" && "[&>div]:bg-amber-500",
          level === "full" && "[&>div]:bg-destructive",
        )}
      />
      <p className="text-xs text-muted-foreground tabular-nums">
        {usage}
        <span aria-hidden> · </span>
        {t("storage:fileCount", { count: fileCount })}
      </p>
      {level !== "ok" && (
        <p
          className={cn(
            "text-xs",
            level === "full"
              ? "text-destructive"
              : "text-amber-700 dark:text-amber-400",
          )}
        >
          {level === "full" ? t("storage:full") : t("storage:almostFull")}
          {level === "warning" && (
            <>
              <span aria-hidden> </span>
              {t("storage:remaining", { remaining: formatBytes(remainingBytes) })}
            </>
          )}
        </p>
      )}
    </div>
  );
}
