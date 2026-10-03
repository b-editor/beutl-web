import type { GitDurableStorage, LfsRecord } from "./lfs";

// Reserve both fixed copy-on-write slots, including obsolete or partially
// written chunks. Keep ample room below the SQLite DO's 10 GB database limit.
export const TUS_TAIL_RESERVED_BYTES = 10 * 1024 * 1024;
export const MAX_TUS_TAIL_RESERVATIONS = 64;
export const MAX_TUS_TAIL_STORAGE_BYTES = TUS_TAIL_RESERVED_BYTES * MAX_TUS_TAIL_RESERVATIONS;
const PREFIX = "tus-tail-budget:";
const SCAN_KEY = "tusTailBudgetScan";
const SCAN_PAGE_SIZE = 50;
interface Scan { cursor?: string; complete?: boolean }

// Older records can have a committed tail or interrupted COW chunks. The LFS
// record outlives those chunks: termination/expiry removes it only after tail
// cleanup. Scan small record pages rather than listing multi-MiB chunk values.
async function adoptLegacyTails(storage: GitDurableStorage): Promise<boolean> {
  const scan = await storage.get<Scan>(SCAN_KEY);
  if (scan?.complete) return true;
  const records = await storage.list<LfsRecord>({ prefix: "lfs:", startAfter: scan?.cursor, limit: SCAN_PAGE_SIZE });
  for (const key of records.keys()) {
    const oid = key.slice(4);
    if (await storage.get<boolean>(`${PREFIX}${oid}`)) continue;
    let stored = !!await storage.get(`tus-tail:${oid}:meta`);
    for (const slot of ["a", "b"]) {
      for (let index = 0; index < 5 && !stored; index++) {
        stored = await storage.get(`tus-tail:${oid}:${slot}:${index}`) !== undefined;
      }
    }
    if (stored) await storage.put(`${PREFIX}${oid}`, true);
  }
  const complete = records.size < SCAN_PAGE_SIZE;
  await storage.put<Scan>(SCAN_KEY, complete ? { complete: true } : { cursor: [...records.keys()].at(-1) });
  return complete;
}

// Must run in the repository DO queue. Reserve before reading the PATCH body
// or writing a B2 part; a rejected PATCH leaves its authoritative offset intact.
export async function reserveTusTail(
  storage: GitDurableStorage, oid: string,
): Promise<"reserved" | "full" | "migrating"> {
  if (!await adoptLegacyTails(storage)) return "migrating";
  const reservations = await storage.list<boolean>({ prefix: PREFIX, limit: MAX_TUS_TAIL_RESERVATIONS + 1 });
  if (reservations.size > MAX_TUS_TAIL_RESERVATIONS) return "full";
  if (reservations.has(`${PREFIX}${oid}`)) return "reserved";
  if (reservations.size === MAX_TUS_TAIL_RESERVATIONS) return "full";
  // Persist first so interruption cannot leave unaccounted partial chunks.
  await storage.put(`${PREFIX}${oid}`, true);
  return "reserved";
}

export async function releaseTusTail(storage: GitDurableStorage, oid: string): Promise<void> {
  // Caller has successfully deleted BOTH slots before making capacity available.
  await storage.delete(`${PREFIX}${oid}`);
}
