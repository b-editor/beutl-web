"use client";

import { cn, formatCount, formatDate, randomUuid } from "@beutl/core";
import { useTranslation } from "@beutl/ui/i18n-client";
import { Alert, AlertDescription, AlertTitle } from "@beutl/ui/ui/alert";
import { Button } from "@beutl/ui/ui/button";
import { Card } from "@beutl/ui/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@beutl/ui/ui/collapsible";
import { Label } from "@beutl/ui/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@beutl/ui/ui/select";
import { Progress } from "@beutl/ui/ui/progress";
import { Shimmer } from "@beutl/ui/ui/skeleton";
import { useToast } from "@beutl/ui/use-toast";
import {
  ChevronRight,
  Copy,
  Download,
  Lock,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export {
  canSubmitAiRequest,
  effectiveImageReferences,
  isAiPromptWithinLimit,
  canSubmitModelRequest,
  blockedReason,
  blocksSubmit,
  correctedModelId,
  digestAiRequestSignature,
  aiRecoveryStorageScope,
  restoreAiRecoveryEntries,
  serializeAiRecoveryEntries,
  IDEMPOTENCY_KEY_FIELD,
  fileFingerprint,
  heldAiRequestModels,
  heldAiRequestModelMap,
  heldAiRequestCapabilityMap,
  heldAiRequestCapability,
  holdsAiRequestModel,
  keepModelForHeldRequest,
  modelsWithHeldRequests,
  mergeHeldModelCapabilities,
  mergeHeldRequestCapabilities,
  mergeAiRecoveryEntries,
  removeAiRecoveryEntry,
  serializeAiRecoveryTombstone,
  isAiRecoveryTombstoned,
  keepsIdempotencyKey,
  readAiRecoverySafely,
  AI_RECOVERY_TTL_MS,
  requestSignature,
  seedValue,
  type AiAccess,
  type AiBalance,
  type AiBlockReason,
  type AiScreenModel,
  type HeldModelCapabilitySnapshots,
  type PersistedAiRecoveryEntry,
} from "@/lib/ai-screen";
import {
  acquireAiRecoveryEntry,
  type AiRecoveryLockManager,
} from "@/lib/ai-recovery-storage";
import {
  aiRecoveryStorageScope,
  digestAiRequestSignature,
  serializeAiRecoveryEntries,
  fileFingerprint,
  heldAiRequestModels,
  heldAiRequestModelMap,
  heldAiRequestCapabilityMap,
  heldAiRequestCapability,
  holdsAiRequestModel,
  holdsAiRequestName,
  IDEMPOTENCY_KEY_FIELD,
  mergeHeldModelCapabilities,
  mergeHeldRequestCapabilities,
  mergeAiRecoveryEntries,
  removeAiRecoveryEntry,
  serializeAiRecoveryTombstone,
  isAiRecoveryTombstoned,
  modelsWithHeldRequests,
  newAiRequestNames,
  readyAiRequestNames,
  reduceAiRequestRecovery,
  readAiRecoverySafely,
  AI_RECOVERY_TTL_MS,
  type AiBalance,
  type AiBlockReason,
  type AiScreenModel,
  type HeldModelCapabilitySnapshots,
  type AiRequestNames,
  type PersistedAiRecoveryEntry,
} from "@/lib/ai-screen";

export function billingHref(lang: string): string {
  return `/${lang}/dashboard/account/billing`;
}

export function AiPageHeader({
  lang,
  title,
  description,
  balance,
}: {
  lang: string;
  title: string;
  description: string;
  // Shown alongside the title because the remaining allowance is what decides
  // whether the work about to be described on this page can run at all.
  balance?: AiBalance;
}) {
  const { t } = useTranslation(lang);
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <Link
          href={`/${lang}/dashboard/ai`}
          prefetch={false}
          className="inline-flex items-center text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronRight className="mr-1 h-4 w-4 rotate-180" />
          {t("dashboard:ai.backToAi")}
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      </div>
      {balance && (
        <Link
          href={`/${lang}/dashboard/ai`}
          prefetch={false}
          className="w-44 rounded-lg border bg-card p-3 text-card-foreground transition-colors hover:bg-accent/50"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {t("dashboard:ai.monthlyUsage")}
            </span>
            <span className="text-sm font-bold tabular-nums">
              {balance.usedPercent}%
            </span>
          </div>
          <Progress
            className={`mt-1.5 h-2 ${usageToneClass(balance)}`}
            value={balance.usedPercent}
            max={100}
            aria-label={t("dashboard:ai.monthlyUsage")}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t("account:aiPlan.additionalCredits")}:{" "}
            {formatCount(balance.additionalCredits, lang)}
          </p>
        </Link>
      )}
    </div>
  );
}

// Why a screen cannot be used, and the one link that resolves it. Both cases
// are dead ends without a way out: subscribing and buying credits both happen
// on the billing page.
export function AiAccessNotice({
  lang,
  reason,
}: {
  lang: string;
  reason: AiBlockReason;
}) {
  const { t } = useTranslation(lang);
  const isPlan = reason === "plan";
  // 提供が止まっている操作は、契約も残高も足しようがない。買い物へ誘導するのは
  // 誤りなので、何が起きているかだけを伝える。
  if (reason === "unavailable") {
    return (
      <Alert>
        <TriangleAlert className="h-4 w-4" />
        <AlertTitle>{t("dashboard:ai.operationUnavailableTitle")}</AlertTitle>
        <AlertDescription>
          {t("dashboard:ai.operationUnavailableDescription")}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant={isPlan ? "default" : "destructive"}>
      {isPlan ? (
        <Lock className="h-4 w-4" />
      ) : (
        <TriangleAlert className="h-4 w-4" />
      )}
      <AlertTitle>
        {isPlan
          ? t("dashboard:ai.planRequiredTitle")
          : t("dashboard:ai.balanceExhaustedTitle")}
      </AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        <span>
          {isPlan
            ? t("dashboard:ai.planRequired")
            : t("dashboard:ai.balanceExhaustedDescription")}
        </span>
        <Button asChild size="sm" variant={isPlan ? "default" : "outline"}>
          <Link href={billingHref(lang)} prefetch={false}>
            {isPlan
              ? t("account:aiPlan.subscribe")
              : t("account:aiPlan.buyCredits")}
          </Link>
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function usageToneClass(balance: AiBalance): string {
  if (balance.isExhausted) return "[&>div]:bg-destructive";
  if (balance.usedPercent >= 80) return "[&>div]:bg-amber-500";
  return "";
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-sm text-muted-foreground">{label}</p>
      <p className="truncate text-2xl font-bold">{value}</p>
    </div>
  );
}

// The allowance is the one number that decides whether an AI screen will work,
// so it leads every AI page rather than living only on the billing page. The
// three figures sit side by side because a single label-and-value row leaves the
// middle of a full-width card empty.
export function AiUsageCard({
  lang,
  balance,
}: {
  lang: string;
  balance: AiBalance;
}) {
  const { t } = useTranslation(lang);
  return (
    <Card className="p-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          label={t("dashboard:ai.monthlyUsage")}
          value={`${balance.usedPercent}%`}
        />
        <Stat
          label={t("account:aiPlan.additionalCredits")}
          value={formatCount(balance.additionalCredits, lang)}
        />
        {balance.periodEnd && (
          <Stat
            label={t(
              balance.endsAtPeriodEnd
                ? "dashboard:ai.planEnds"
                : "dashboard:ai.nextReset",
            )}
            value={formatDate(balance.periodEnd, lang)}
          />
        )}
      </div>

      <Progress
        className={`mt-4 ${usageToneClass(balance)}`}
        value={balance.usedPercent}
        max={100}
        aria-label={t("dashboard:ai.monthlyUsage")}
      />

      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-sm text-muted-foreground">
          {balance.isExhausted
            ? t("dashboard:ai.monthlyUsageExhausted")
            : t("account:aiPlan.monthlyUsageHint", {
                percent: balance.remainingPercent,
              })}
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href={billingHref(lang)} prefetch={false}>
            {t("account:aiPlan.buyCredits")}
          </Link>
        </Button>
      </div>

      {balance.hasAdditionalCreditDebt && (
        <p className="mt-3 text-sm text-amber-600 dark:text-amber-500">
          {t("account:aiPlan.additionalCreditDebtNotice")}
        </p>
      )}
    </Card>
  );
}

// One submission is one attempt, and every arrival of that attempt at the server
// — a double click, a retried POST, a second tab — would otherwise reserve and
// charge again. The key identifies the attempt so duplicates collapse onto the
// first job.
//
// It is generated after mount rather than during render: a value produced on the
// server would either differ from the hydrated one or, if derived from the tree,
// repeat across page loads and collide with an unrelated attempt.
//
// It rotates when the action settles, so the next deliberate run is a new
// attempt — but only then. A run that is still going, or one whose paid result
// could not be read, is not settled: the name it was sent under is the way back
// to what it already bought, and a new one would buy it again.
/**
 * 選ばれているファイルの中身の見分けと、まだ読めていないかどうか。
 *
 * 読み終える前に送れてしまうと、中身の分からないまま作った名前で課金され、
 * 読み終えた時点で名前が変わって、やり直しが二度目の課金になる。読んでいる間は
 * 送らせない。
 *
 * 遅れて届いた読み取りは捨てる。A を選んですぐ B に変えると、A の読み取りが
 * B の見分けとして収まり、B が A の名前で送られる。
 */
export function useFileFingerprints(
  files: readonly File[],
  limit: number,
): { contents: string[]; reading: boolean } {
  const [read, setRead] = useState<{ files: readonly File[]; contents: string[] }>(
    { files: [], contents: [] },
  );

  useEffect(() => {
    let current = true;
    void Promise.all(files.map((file) => fileFingerprint(file, limit)))
      .then((contents) => {
        if (current) setRead({ files, contents });
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [files, limit]);

  const ready = read.files.length === files.length
    && read.files.every((file, index) => file === files[index]);
  return {
    contents: ready ? read.contents : [],
    reading: files.length > 0 && !ready,
  };
}

/**
 * 送信ごとの名前を、依頼ごとに持っておく。どれを残しどれを手放すかは
 * {@link commitAiRequestName} と {@link settleAiRequestName} が決める。
 */
function recoveryStorageKey(userId: string, operation: string): string {
  return aiRecoveryStorageScope(userId, operation);
}

function recoveryEntryStoragePrefix(userId: string, operation: string): string {
  return `${recoveryStorageKey(userId, operation)}.active.`;
}

function recoveryTombstoneStoragePrefix(userId: string, operation: string): string {
  return `${recoveryStorageKey(userId, operation)}.settled.`;
}

function recoveryEntryStorageKey(
  userId: string,
  operation: string,
  digest: string,
  key: string,
): string {
  return `${recoveryEntryStoragePrefix(userId, operation)}${digest}.${encodeURIComponent(key)}`;
}

function recoveryTombstoneStorageKey(
  userId: string,
  operation: string,
  digest: string,
  key: string,
): string {
  return `${recoveryTombstoneStoragePrefix(userId, operation)}${digest}.${encodeURIComponent(key)}`;
}

function migratePersistedRecovery(
  userId: string,
  operation: string,
  entries: readonly PersistedAiRecoveryEntry[],
): boolean {
  try {
    // Migration writes only the validated legacy digests. Normal mutations do
    // not call this function and therefore never rewrite sibling records.
    for (const entry of entries) {
      window.localStorage.setItem(
        recoveryEntryStorageKey(userId, operation, entry.digest, entry.key),
        serializeAiRecoveryEntries([entry]),
      );
    }
    window.localStorage.removeItem(recoveryStorageKey(userId, operation));
    return true;
  } catch {
    return false;
  }
}

function writePersistedRecoveryEntry(
  userId: string,
  operation: string,
  entry: PersistedAiRecoveryEntry,
): boolean {
  try {
    if (isAiRecoveryTombstoned(
      window.localStorage.getItem(
        recoveryTombstoneStorageKey(userId, operation, entry.digest, entry.key),
      ),
      entry.key,
    )) return false;
    window.localStorage.setItem(
      recoveryEntryStorageKey(userId, operation, entry.digest, entry.key),
      serializeAiRecoveryEntries([entry]),
    );
    const persisted = readAiRecoverySafely(
      () => window.localStorage.getItem(
        recoveryEntryStorageKey(userId, operation, entry.digest, entry.key),
      ),
    );
    return persisted.some((candidate) =>
      candidate.digest === entry.digest && candidate.key === entry.key,
    );
  } catch {
    return false;
  }
}

function aiRecoveryLockName(
  userId: string,
  operation: string,
): string {
  // Allocate every digest in one account/operation scope behind the same
  // lock. A per-digest lock prevents duplicate keys for one body, but two
  // different bodies could both observe slot 63 and overrun the physical
  // recovery capacity.
  return `${recoveryStorageKey(userId, operation)}.lock`;
}

/**
 * Allocate and durably publish one idempotency identity. The lock is scoped to
 * the account and operation, so two mounted forms converge on the same key and
 * different digests cannot race the shared active-entry capacity.
 * A pre-existing durable entry remains usable without Web Locks; minting a new
 * key without the lock is deliberately refused because two tabs could charge
 * the same request independently.
 */
async function acquirePersistedRecoveryEntry({
  userId,
  operation,
  digest,
  model,
  capability,
  createKey,
  locks,
}: {
  userId: string;
  operation: string;
  digest: string;
  model: string;
  capability: unknown | null;
  createKey: () => string;
  locks: AiRecoveryLockManager | undefined;
}): Promise<PersistedAiRecoveryEntry | null> {
  if (typeof window === "undefined" || !userId) return null;
  return acquireAiRecoveryEntry({
    lockName: aiRecoveryLockName(userId, operation),
    digest,
    model,
    capability,
    readEntries: () => readPersistedRecovery(userId, operation),
    writeEntry: (entry) => writePersistedRecoveryEntry(userId, operation, entry),
    createKey,
    locks,
    maxEntries: 64,
  });
}

function removePersistedRecoveryEntry(
  userId: string,
  operation: string,
  digest: string,
  key: string,
): boolean {
  try {
    // Keep an exact-key tombstone. A stale tab may write the old active item
    // after this remove, but restore still ignores that settled generation;
    // a legitimate new generation uses another key and remains recoverable.
    window.localStorage.setItem(
      recoveryTombstoneStorageKey(userId, operation, digest, key),
      serializeAiRecoveryTombstone(key),
    );
    window.localStorage.removeItem(
      recoveryEntryStorageKey(userId, operation, digest, key),
    );
    return true;
  } catch {
    return false;
  }
}

type RecoveryTombstone = { key: string; settledAt: number };

function readRecoveryTombstone(
  raw: string | null,
  now: number,
): RecoveryTombstone | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as {
      version?: unknown;
      key?: unknown;
      settledAt?: unknown;
    };
    if (
      value.version !== 1 ||
      typeof value.key !== "string" ||
      value.key.length === 0 ||
      value.key.length > 255 ||
      (value.settledAt !== undefined &&
        (typeof value.settledAt !== "number" || !Number.isFinite(value.settledAt)))
    ) {
      return null;
    }
    const settledAt = value.settledAt === undefined ? now : value.settledAt;
    if (settledAt > now || now - settledAt > AI_RECOVERY_TTL_MS) return null;
    return { key: value.key, settledAt };
  } catch {
    return null;
  }
}

function readPersistedRecovery(
  userId: string,
  operation: string,
): PersistedAiRecoveryEntry[] {
  if (!userId || typeof window === "undefined") return [];
  const now = Date.now();
  const storage = window.localStorage;
  const all: PersistedAiRecoveryEntry[] = [];
  const activeKeys: string[] = [];
  const tombstoneKeys: string[] = [];
  try {
    const legacyKey = recoveryStorageKey(userId, operation);
    const legacyRaw = storage.getItem(legacyKey);
    const legacy = readAiRecoverySafely(() => legacyRaw, now);
    all.push(...legacy);
    if (legacyRaw !== null && legacy.length === 0) {
      // A malformed or fully expired aggregate is no longer useful and can
      // otherwise consume quota forever.
      storage.removeItem(legacyKey);
    }

    const activePrefix = recoveryEntryStoragePrefix(userId, operation);
    const tombstonePrefix = recoveryTombstoneStoragePrefix(userId, operation);
    // Snapshot keys before mutating localStorage; removing a key while walking
    // its live index skips the following key in some browser implementations.
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => key !== null);
    for (const key of keys) {
      if (key.startsWith(activePrefix)) activeKeys.push(key);
      else if (key.startsWith(tombstonePrefix)) tombstoneKeys.push(key);
    }

    const tombstones = new Map<string, RecoveryTombstone>();
    for (const key of tombstoneKeys) {
      const tombstone = readRecoveryTombstone(storage.getItem(key), now);
      if (!tombstone) {
        storage.removeItem(key);
        continue;
      }
      tombstones.set(key, tombstone);
    }

    for (const key of activeKeys) {
      const entries = readAiRecoverySafely(() => storage.getItem(key), now);
      if (entries.length === 0) {
        storage.removeItem(key);
        continue;
      }
      let kept = false;
      for (const entry of entries) {
        const tombstoneKey = recoveryTombstoneStorageKey(
          userId,
          operation,
          entry.digest,
          entry.key,
        );
        const tombstone = tombstones.get(tombstoneKey);
        if (tombstone && tombstone.key === entry.key) {
          storage.removeItem(key);
          continue;
        }
        all.push(entry);
        kept = true;
      }
      if (!kept) storage.removeItem(key);
    }

    const merged = mergeAiRecoveryEntries([], all);
    const keepDigests = new Set(merged.map((entry) => `${entry.digest}\u0000${entry.key}`));
    // Bound physical active records, not just the logical restored array. This
    // removes duplicate generations and stale tab spillover after a long-lived
    // session, while tombstones fence any late old-generation write.
    for (const key of activeKeys) {
      const entries = readAiRecoverySafely(() => storage.getItem(key), now);
      if (entries.length === 0 || entries.every((entry) => !keepDigests.has(`${entry.digest}\u0000${entry.key}`))) {
        try { storage.removeItem(key); } catch { /* best effort GC */ }
      }
    }
    const keptTombstones = tombstoneKeys
      .map((key) => ({ key, tombstone: tombstones.get(key) }))
      .filter((value): value is { key: string; tombstone: RecoveryTombstone } => value.tombstone !== undefined)
      .sort((left, right) => right.tombstone.settledAt - left.tombstone.settledAt)
      .slice(0, 2 * 64);
    const keepTombstones = new Set(keptTombstones.map((value) => value.key));
    for (const key of tombstoneKeys) {
      if (!keepTombstones.has(key)) {
        try { storage.removeItem(key); } catch { /* best effort GC */ }
      }
    }

    // Migrate the legacy aggregate only after the per-digest records have been
    // merged. A stale mount can therefore never erase a sibling's key.
    if (legacyRaw !== null && merged.length > 0) {
      migratePersistedRecovery(userId, operation, merged);
    }
    return merged;
  } catch {
    // Privacy mode and quota errors must not make the form unusable. Callers
    // still fail closed for new allocations when persistence cannot be proven.
    return mergeAiRecoveryEntries([], all);
  }
}

export function useAiRequestNames(userId = "", operation = "unknown"): {
  ready: boolean;
  nameFor: (request: string) => string;
  holds: (request: string) => boolean;
  holdsModel: (model: string) => boolean;
  hasRestoredModel: (model: string) => boolean;
  restoredModels: () => string[];
  restoredModelsKey: string;
  heldModels: () => string[];
  heldRequestModels: () => Readonly<Record<string, string>>;
  heldRequestCapabilities: () => Readonly<Record<string, unknown | null>>;
  heldCapabilityFor: (request: string) => unknown | null | undefined;
  ensure: (request: string) => Promise<void>;
  ensureAndGet: (request: string) => Promise<string>;
  /** Allocate, persist, and hold one key as a single operation. */
  acquireAndCommit: (
    request: string,
    model?: string,
    capability?: unknown | null,
  ) => Promise<string>;
  modelsWithHeld: (models: readonly AiScreenModel[]) => AiScreenModel[];
  commit: (request: string) => void;
  commitWithModel: (request: string, model: string, capability?: unknown) => void;
  settle: (keeps: boolean) => void;
} {
  const [names, setNames] = useState(newAiRequestNames);
  const namesRef = useRef(names);
  const restoredRef = useRef<Map<string, PersistedAiRecoveryEntry>>(new Map());
  const requestDigestsRef = useRef<Map<string, string>>(new Map());
  const entriesRef = useRef<PersistedAiRecoveryEntry[]>([]);
  const ensurePromisesRef = useRef<Map<string, Promise<void>>>(new Map());
  const acquirePromisesRef = useRef<Map<string, Promise<string>>>(new Map());
  const generationRef = useRef(0);
  const [ready, setReady] = useState(false);
  const [storageVersion, setStorageVersion] = useState(0);

  useEffect(() => {
    let active = true;
    ++generationRef.current;
    setReady(false);
    namesRef.current = newAiRequestNames();
    requestDigestsRef.current = new Map();
    ensurePromisesRef.current.clear();
    acquirePromisesRef.current.clear();
    const entries = typeof window === "undefined" || !userId
      ? []
      : readAiRecoverySafely(() => window.localStorage.getItem(recoveryStorageKey(userId, operation)));
    let currentEntries = entries;
    if (typeof window !== "undefined" && userId) {
      // A mount-time cleanup must merge with what is in storage now. Writing
      // the array captured before another tab's update would erase that tab's
      // recovery key.
      currentEntries = mergeAiRecoveryEntries(
        readPersistedRecovery(userId, operation),
        entries,
      );
    }
    entriesRef.current = currentEntries;
    restoredRef.current = new Map(currentEntries.map((entry) => [entry.digest, entry]));
    const next = readyAiRequestNames(newAiRequestNames(), randomUuid);
    namesRef.current = next;
    if (active) {
      setNames(next);
      setReady(true);
    }
    return () => { active = false; };
  }, [operation, userId]);

  useEffect(() => {
    if (typeof window === "undefined" || !userId) return;
    const key = recoveryStorageKey(userId, operation);
    const prefix = recoveryEntryStoragePrefix(userId, operation);
    const tombstones = recoveryTombstoneStoragePrefix(userId, operation);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key
        && !event.key?.startsWith(prefix)
        && !event.key?.startsWith(tombstones)) return;
      const next = readPersistedRecovery(userId, operation);
      entriesRef.current = next;
      restoredRef.current = new Map(next.map((entry) => [entry.digest, entry]));
      // A request may already have been digested while another tab allocated
      // its key. Pull that durable identity into this instance immediately;
      // waiting for a future ensure call would leave the hidden form field and
      // the submit guard on a different generation.
      let current = namesRef.current;
      let changed = false;
      for (const [request, digest] of requestDigestsRef.current) {
        const entry = restoredRef.current.get(digest);
        if (!entry) continue;
        const heldKey = current.held[request];
        if (heldKey === entry.key) continue;
        if (heldKey !== undefined) {
          // Never replace an in-flight key with a late storage event. The
          // durable tombstone/active pair already fences old generations; the
          // request that was actually sent must retain its original key.
          continue;
        }
        current = {
          ...current,
          held: { ...current.held, [request]: entry.key },
          heldModels: { ...current.heldModels, [request]: entry.model },
          heldCapabilities: {
            ...current.heldCapabilities,
            [request]: entry.capability,
          },
        };
        changed = true;
      }
      if (changed) {
        namesRef.current = current;
        setNames(current);
      }
      setStorageVersion((version) => version + 1);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [operation, userId]);

  useEffect(() => { namesRef.current = names; }, [names]);

  const acquireAndCommit = useCallback(async (
    request: string,
    model = "",
    capability: unknown | null = null,
  ): Promise<string> => {
    if (!ready) return "";
    const pending = acquirePromisesRef.current.get(request);
    if (pending) return pending;
    const requestGeneration = generationRef.current;
    const task = (async () => {
      const digest = await digestAiRequestSignature(request);
      if (generationRef.current !== requestGeneration) return "";
      requestDigestsRef.current.set(request, digest);

      const currentlyHeld = namesRef.current.held[request];
      if (currentlyHeld) {
        namesRef.current = { ...namesRef.current, sent: request };
        setNames(namesRef.current);
        return currentlyHeld;
      }

      const locks = typeof navigator !== "undefined"
        ? (navigator as Navigator & { locks?: AiRecoveryLockManager }).locks
        : undefined;
  const entry = await acquirePersistedRecoveryEntry({
        userId,
        operation,
        digest,
        model,
        capability,
        createKey: randomUuid,
        locks,
  });
      if (!entry || generationRef.current !== requestGeneration) return "";

      const current = namesRef.current;
      if (current.held[request]) {
        namesRef.current = { ...current, sent: request };
        setNames(namesRef.current);
        return current.held[request];
      }
      // The durable entry is written before this state becomes visible. A
      // response-loss retry in another tab can therefore always discover the
      // same identity, even if this render is torn down immediately.
      const next: AiRequestNames = {
        ...current,
        held: { ...current.held, [request]: entry.key },
        heldModels: { ...current.heldModels, [request]: entry.model },
        heldCapabilities: {
          ...current.heldCapabilities,
          [request]: entry.capability,
        },
        sent: request,
      };
      namesRef.current = next;
      setNames(next);
      entriesRef.current = mergeAiRecoveryEntries(
        readPersistedRecovery(userId, operation),
        [entry],
      );
      restoredRef.current.set(digest, entry);
      return entry.key;
    })();
    acquirePromisesRef.current.set(request, task);
    try {
      return await task;
    } finally {
      if (acquirePromisesRef.current.get(request) === task) {
        acquirePromisesRef.current.delete(request);
      }
    }
  }, [operation, ready, userId]);

  const ensure = useCallback(async (request: string): Promise<void> => {
    if (!ready) return;
    if (requestDigestsRef.current.has(request)) return;
    const pending = ensurePromisesRef.current.get(request);
    if (pending) return pending;
    const requestGeneration = generationRef.current;
    const task = (async () => {
      const digest = await digestAiRequestSignature(request);
      if (generationRef.current !== requestGeneration) return;
      requestDigestsRef.current.set(request, digest);
      const restored = restoredRef.current.get(digest);
      if (!restored || request in namesRef.current.held) return;
      const current = namesRef.current;
      const restoredNames: AiRequestNames = {
        ...current,
        held: { ...current.held, [request]: restored.key },
        heldModels: { ...current.heldModels, [request]: restored.model },
        heldCapabilities: { ...current.heldCapabilities, [request]: restored.capability },
      };
      namesRef.current = restoredNames;
      setNames(restoredNames);
    })();
    ensurePromisesRef.current.set(request, task);
    try { await task; } finally {
      if (ensurePromisesRef.current.get(request) === task) {
        ensurePromisesRef.current.delete(request);
      }
    }
  }, [ready]);

  const ensureAndGet = useCallback(async (request: string): Promise<string> => {
    const generation = generationRef.current;
    await ensure(request);
    if (generationRef.current !== generation || !ready) return "";
    // This compatibility helper only returns a durable/held identity. It no
    // longer exposes the private `next` UUID because that value has not gone
    // through the lock-and-persist allocation protocol yet.
    return namesRef.current.held[request] ?? "";
  }, [ensure, ready]);

  const persist = useCallback((request: string, key: string, model: string, capability: unknown | null): void => {
    if (!userId || typeof window === "undefined") return;
    const digest = requestDigestsRef.current.get(request);
    if (!digest) return;
    const entry: PersistedAiRecoveryEntry = {
      digest,
      key,
      model,
      capability,
      updatedAt: Date.now(),
    };
    // Read at mutation time. The mount snapshot may be stale because another
    // tab can commit a different request between renders.
    entriesRef.current = mergeAiRecoveryEntries(
      readPersistedRecovery(userId, operation),
      [entry],
    );
    writePersistedRecoveryEntry(userId, operation, entry);
  }, [operation, userId]);

  const commit = useCallback((request: string, model = "", capability: unknown | null = null): void => {
    const current = namesRef.current;
    const next = reduceAiRequestRecovery(current, {
      type: "commit", request, model, capability,
    }, randomUuid);
    namesRef.current = next;
    setNames(next);
    const key = next.held[request];
    if (key) persist(request, key, model, capability);
  }, [persist]);

  const settle = useCallback((keeps: boolean): void => {
    const current = namesRef.current;
    const sent = current.sent;
    const next = reduceAiRequestRecovery(current, { type: "settle", keeps });
    namesRef.current = next;
    setNames(next);
    if (!keeps && sent) {
      const digest = requestDigestsRef.current.get(sent);
      const settledKey = current.held[sent];
      if (digest && settledKey) {
        const latest = readPersistedRecovery(userId, operation);
        entriesRef.current = removeAiRecoveryEntry(latest, digest);
        removePersistedRecoveryEntry(userId, operation, digest, settledKey);
      }
    }
  }, [operation, userId]);

  const restoredModelsKey = `${storageVersion}:${[...new Set(entriesRef.current.map((entry) => entry.model))].join("\u001f")}`;
  return useMemo(() => ({
    ready,
    // Do not expose the private next UUID in a form field. A key becomes
    // visible only after acquireAndCommit has durably persisted its digest
    // record (or an existing record has been restored).
    nameFor: (request: string) => namesRef.current.held[request] ?? "",
    holds: (request: string) => holdsAiRequestName(namesRef.current, request),
    holdsModel: (model: string) => holdsAiRequestModel(namesRef.current, model),
    hasRestoredModel: (model: string) =>
      entriesRef.current.some((entry) => entry.model === model),
    restoredModels: () => [...new Set(entriesRef.current.map((entry) => entry.model))],
    restoredModelsKey,
    heldModels: () => heldAiRequestModels(namesRef.current),
    heldRequestModels: () => heldAiRequestModelMap(namesRef.current),
    heldRequestCapabilities: () => heldAiRequestCapabilityMap(namesRef.current),
    heldCapabilityFor: (request: string) => heldAiRequestCapability(namesRef.current, request),
    acquireAndCommit,
    ensureAndGet,
    modelsWithHeld: (models: readonly AiScreenModel[]) =>
      modelsWithHeldRequests(models, [
        ...heldAiRequestModels(namesRef.current),
        ...entriesRef.current.map((entry) => entry.model),
      ]),
    ensure,
    commit: (request: string) => commit(request),
    commitWithModel: (request: string, model: string, capability?: unknown) =>
      commit(request, model, capability ?? null),
    settle,
  }), [acquireAndCommit, commit, ensure, ensureAndGet, ready, restoredModelsKey, settle]);
}

/**
 * Freeze the first capability description observed for a held paid model. A
 * catalog refresh may remove or mutate that entry, but replaying the held
 * signature must use the same option normalization as the original request.
 */
export function useHeldModelCapabilities<T>(
  capabilities: Record<string, T> | undefined,
  heldModels: readonly string[] | Readonly<Record<string, string>>,
  observedModels: readonly string[] = [],
  heldCapabilities: Readonly<Record<string, unknown | null>> = {},
): Record<string, T> {
  const snapshots = useRef<HeldModelCapabilitySnapshots<T>>({});
  const snapshotsNext = { ...snapshots.current };
  const heldRequestModels: Readonly<Record<string, string>> = Array.isArray(heldModels)
    ? Object.fromEntries(heldModels.map((model) => [model, model]))
    : heldModels;
  for (const [request, model] of Object.entries(heldRequestModels)) {
    if (!(request in snapshotsNext)) {
      const capability = heldCapabilities[request];
      snapshotsNext[request] = capability === undefined
        ? (capabilities?.[model] ?? null)
        : capability as T | null;
    }
  }
  for (const request of Object.keys(snapshotsNext)) {
    if (!(request in heldRequestModels)) delete snapshotsNext[request];
  }
  const merged = Array.isArray(heldModels)
    ? mergeHeldModelCapabilities(
      capabilities,
      snapshotsNext,
      heldModels,
      observedModels,
    )
    : mergeHeldRequestCapabilities(
      capabilities,
      snapshotsNext,
      heldRequestModels,
    );
  snapshots.current = snapshotsNext;
  return merged;
}


// The idempotency key travels as a form field. Screens that can tell one
// request from another pass a signature of it, so a name is kept for as long as
// the request it belongs to is unsettled; the rest pass nothing and hold one
// name at a time, which is how they behaved before.
export function IdempotencyKeyField({ name }: { name: string }) {
  return <input type="hidden" name={IDEMPOTENCY_KEY_FIELD} value={name} />;
}

// Input on the left, what the run produced on the right. Splitting them fills
// the width a single column left empty and puts a fresh result on screen
// without scrolling past the form that made it. Omitting `result` gives the
// one-column form used by screens that produce nothing inline.
export function AiWorkspace({
  form,
  result,
}: {
  form: ReactNode;
  result?: ReactNode;
}) {
  if (!result) {
    return <div className="max-w-4xl">{form}</div>;
  }
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      {form}
      {result}
    </div>
  );
}

// Holds the right column open before the first run so the form does not jump
// sideways when a result arrives. Hidden where the columns stack, since there
// it would only push the form off screen.
export function ResultPlaceholder({
  icon: Icon,
  label,
}: {
  icon: typeof Sparkles;
  label: string;
}) {
  return (
    <div className="hidden min-h-64 flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-6 text-center lg:flex">
      <Icon className="h-8 w-8 text-muted-foreground/60" />
      <p className="max-w-xs text-sm text-muted-foreground">{label}</p>
    </div>
  );
}

// What the right column shows while a request is running. A placeholder that
// stays still reads as "nothing is happening" on an operation that takes a
// minute; the band of light says the wait is expected.
export function ResultShimmer({ label }: { label: string }) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <p className="inline-flex items-center gap-2 font-bold">
        <Sparkles className="h-4 w-4 animate-pulse text-muted-foreground" />
        {label}
      </p>
      <Shimmer className="min-h-64 w-full" />
      <Shimmer className="h-4 w-2/3" />
    </Card>
  );
}

// A picture that shimmers until it has actually arrived. The URL comes back
// before the bytes do, and an empty frame in the meantime looks like a result
// that failed to render.
export function ShimmerImage({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="relative">
      {!loaded && <Shimmer className="absolute inset-0 min-h-48 w-full" />}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        onLoad={() => setLoaded(true)}
        className={cn(
          className,
          "transition-opacity",
          loaded ? "opacity-100" : "min-h-48 opacity-0",
        )}
      />
    </div>
  );
}

// Optional prompt refinements are what a first-time visitor should not have to
// read past to reach the submit button, but they are also what a returning user
// reaches for every time — hence collapsed, not hidden.
export function AdvancedOptions({
  lang,
  children,
  defaultOpen = false,
}: {
  lang: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation(lang);
  return (
    <Collapsible defaultOpen={defaultOpen} className="group/advanced">
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-2 text-muted-foreground"
        >
          <ChevronRight className="mr-1 h-4 w-4 transition-transform duration-200 group-data-[state=open]/advanced:rotate-90" />
          {t("dashboard:ai.advancedOptions")}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-4 pt-4">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

// The model this request should run on.
//
// Hidden entirely when the operation offers one: there is nothing to choose,
// and the server uses that model whether the field is sent or not. Models the
// balance cannot cover stay visible but unselectable — hiding them would make
// the shorter list look like the whole offering.
export function ModelSelect({
  lang,
  models,
  value,
  onChange,
  disabled = false,
}: {
  lang: string;
  models: AiScreenModel[];
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation(lang);
  // The chosen model travels with the request even when there is nothing to
  // choose between. A screen may be offering fewer models than are registered —
  // video drops the ones that cannot serve any request it can build — and a
  // form that submits no model silently runs on the registered default instead.
  if (models.length <= 1 && (models[0]?.id ?? "") === value) {
    return value ? <input type="hidden" name="model" value={value} /> : null;
  }

  return (
    <div className="flex flex-col space-y-1.5">
      <Label htmlFor="aiModel">{t("dashboard:ai.model")}</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id="aiModel">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {models.map((model) => (
            <SelectItem
              key={model.id}
              value={model.id}
              disabled={!model.available}
              // What the model costs relative to the others, or why it cannot
              // be picked at all — the reason belongs next to the choice.
              hint={
                !model.available
                  ? t("dashboard:ai.modelUnaffordable")
                  : model.costTier
                    ? t(`dashboard:ai.costTier.${model.costTier}`)
                    : ""
              }
            >
              {model.displayName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <input type="hidden" name="model" value={value} />
    </div>
  );
}

// The model a screen should start on: the first one the account can actually
// pay for, falling back to the first on offer so the field is never empty.
export function defaultModelId(models: AiScreenModel[]): string {
  return (models.find((model) => model.available) ?? models[0])?.id ?? "";
}

export function downloadTextFile(
  text: string,
  filename: string,
  mimeType = "text/plain;charset=utf-8",
) {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoking on this tick aborts the download on a browser that does not start
  // it synchronously inside click().
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Generated media is served from this origin's authenticated content route, so
// the browser honours `download` and the file lands with a usable name instead
// of opening in a tab.
export function downloadFromUrl(url: string, filename: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
}

export function CopyButton({
  lang,
  text,
  label,
}: {
  lang: string;
  text: () => string;
  label?: string;
}) {
  const { t } = useTranslation(lang);
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text());
          setCopied(true);
          // Long enough to read, short enough that the button is ready again
          // before a second copy.
          window.setTimeout(() => setCopied(false), 2000);
        } catch {
          toast({
            title: t("dashboard:ai.copyFailed"),
            variant: "destructive",
          });
        }
      }}
    >
      <Copy className="mr-2 h-4 w-4" />
      {copied ? t("dashboard:ai.copied") : (label ?? t("dashboard:ai.copy"))}
    </Button>
  );
}

export function DownloadButton({
  label,
  onDownload,
}: {
  label: string;
  onDownload: () => void;
}) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={onDownload}>
      <Download className="mr-2 h-4 w-4" />
      {label}
    </Button>
  );
}

// A finished result is the moment the screen has something to say, and it owns
// the right column. It carries the same weight as the form card rather than
// reading as one more field inside it.
export function ResultPanel({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="inline-flex items-center gap-2 font-bold">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          {title}
        </p>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children}
    </Card>
  );
}
