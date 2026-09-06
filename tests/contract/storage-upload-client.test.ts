import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discardPendingStorageUploadCompletion,
  loadPendingStorageUploadCompletions,
  persistPendingStorageUploadCompletion,
  resumeStorageUploadCompletion,
  tryAcquireStorageUploadLock,
  releaseStorageUploadLock,
  withStorageUploadLock,
  uploadStorageFile,
} from "../../apps/web/src/lib/storage-upload";
import { showOpenFileDialog } from "../../apps/web/src/lib/fileDialog";

describe("storage upload receipt recovery", () => {
  function storageStub() {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] ?? null,
    };
  }
  function durableStorageStub() {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] ?? null,
    };
  }
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("reuses the same completion handle after commit then response loss", async () => {
    vi.useFakeTimers();
    let file: File | null = new File(["bytes"], "clip.mp4", { type: "video/mp4" });
    const storage = storageStub();
    vi.stubGlobal("sessionStorage", storage);
    let completionCalls = 0;
    let persistedBeforeCompletion = false;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input, init) => {
        const url = String(input);
        if (url.endsWith("/storage/uploads") && init?.method === "POST") {
          return new Response(
            JSON.stringify({ id: "upload-1", partSize: 5, partCount: 1 }),
            { status: 200 },
          );
        }
        if (url.endsWith("/parts/1")) {
          return new Response(JSON.stringify({ etag: "etag-1" }), { status: 200 });
        }
        completionCalls++;
        persistedBeforeCompletion =
          loadPendingStorageUploadCompletions("account-a", storage).some(
            (entry) => entry.uploadId === "upload-1",
          );
        if (completionCalls <= 4) {
          // The server committed, but the body was lost on every retry.
          return new Response("committed-but-unreadable", { status: 200 });
        }
        return new Response(
          JSON.stringify({ id: "file-1", name: "clip.mp4", size: 5 }),
          { status: 200 },
        );
      },
    );

    const firstAttempt = uploadStorageFile(file!, { ownerId: "account-a" });
    await vi.runAllTimersAsync();
    await expect(firstAttempt).resolves.toMatchObject({
      ok: false,
      errorCode: "uploadFailed",
      pendingCompletion: { uploadId: "upload-1" },
    });

    // The picker and its File object are gone. Only the serializable receipt
    // handle crosses the retry boundary.
    const firstHandle = (await firstAttempt).pendingCompletion;
    expect(firstHandle?.uploadId).toBe("upload-1");
    file = null;
    const recovered = await resumeStorageUploadCompletion(firstHandle!);
    expect(recovered).toEqual({
      ok: true,
      file: { id: "file-1", name: "clip.mp4", size: 5 },
    });
    expect(completionCalls).toBe(5);
    expect(persistedBeforeCompletion).toBe(true);
    expect(
      fetchMock.mock.calls.filter(([input, init]) =>
        String(input).endsWith("/storage/uploads") && init?.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("does not return a handle for a terminal completion response", async () => {
    vi.stubGlobal("sessionStorage", storageStub());
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error_code: "uploadNotFound" }), {
        status: 404,
      }),
    );
    const outcome = await resumeStorageUploadCompletion({
      uploadId: "upload-terminal",
      body: JSON.stringify({ parts: [] }),
      ownerId: "account-a",
    });
    expect(outcome).toEqual({ ok: false, errorCode: "uploadNotFound" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not complete when both browser stores reject the receipt", async () => {
    const broken = {
      getItem: () => null,
      setItem: () => { throw new Error("storage unavailable"); },
      removeItem: () => undefined,
      length: 0,
      key: () => null,
    };
    vi.stubGlobal("localStorage", broken);
    vi.stubGlobal("sessionStorage", broken);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const pending = { uploadId: "upload-volatile", body: "{}", ownerId: "account-a" } as const;

    await expect(resumeStorageUploadCompletion(pending)).resolves.toEqual({
      ok: false,
      errorCode: "storagePersistenceUnavailable",
      pendingCompletion: pending,
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const recoveredStorage = storageStub();
    vi.stubGlobal("localStorage", recoveredStorage);
    vi.stubGlobal("sessionStorage", recoveredStorage);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "file-volatile", name: "a", size: 1 }), {
        status: 200,
      }),
    );
    await expect(resumeStorageUploadCompletion(pending)).resolves.toEqual({
      ok: true,
      file: { id: "file-volatile", name: "a", size: 1 },
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("upload-volatile");
  });

  it("persists a queue of handles and clears only the completed one", () => {
    const storage = storageStub();
    const first = { uploadId: "upload-1", body: "{}" } as const;
    const second = { uploadId: "upload-2", body: "{}" } as const;
    const firstOwned = { ...first, ownerId: "account-a" };
    const secondOwned = { ...second, ownerId: "account-a" };
    persistPendingStorageUploadCompletion(firstOwned, storage);
    persistPendingStorageUploadCompletion(secondOwned, storage);
    expect(loadPendingStorageUploadCompletions("account-a", storage)).toEqual([firstOwned, secondOwned]);
    discardPendingStorageUploadCompletion(first.uploadId, "account-a", storage);
    expect(loadPendingStorageUploadCompletions("account-a", storage)).toEqual([secondOwned]);
  });

  it("persists each handle independently for a new tab", () => {
    const storage = durableStorageStub();
    const first = { uploadId: "upload-new-tab-1", body: "{}" } as const;
    const second = { uploadId: "upload-new-tab-2", body: "{}" } as const;
    persistPendingStorageUploadCompletion({ ...first, ownerId: "account-a" }, storage);
    persistPendingStorageUploadCompletion({ ...second, ownerId: "account-a" }, storage);
    expect(loadPendingStorageUploadCompletions("account-a", storage)).toHaveLength(2);
    discardPendingStorageUploadCompletion(first.uploadId, "account-a", storage);
    expect(loadPendingStorageUploadCompletions("account-a", storage)).toEqual([
      { ...second, ownerId: "account-a" },
    ]);
  });

  it("does not lose a handle when two tabs persist concurrently", () => {
    const storage = durableStorageStub();
    const first = { uploadId: "upload-race-1", body: "{}" } as const;
    const second = { uploadId: "upload-race-2", body: "{}" } as const;
    persistPendingStorageUploadCompletion({ ...first, ownerId: "account-a" }, storage);
    persistPendingStorageUploadCompletion({ ...second, ownerId: "account-a" }, storage);
    expect(
      loadPendingStorageUploadCompletions("account-a", storage).map((entry) => entry.uploadId),
    ).toEqual([first.uploadId, second.uploadId]);
  });

  it("falls back to sessionStorage when localStorage cannot be written", () => {
    const session = durableStorageStub();
    const brokenLocal = {
      getItem: () => null,
      setItem: () => { throw new Error("local storage unavailable"); },
      removeItem: () => undefined,
      length: 0,
      key: () => null,
    };
    vi.stubGlobal("localStorage", brokenLocal);
    vi.stubGlobal("sessionStorage", session);
    const pending = {
      uploadId: "upload-session-fallback",
      body: "{}",
      ownerId: "account-a",
    } as const;

    persistPendingStorageUploadCompletion(pending);

    expect(loadPendingStorageUploadCompletions("account-a")).toEqual([pending]);
  });

  it("prefers a recovered local receipt and removes its stale session fallback", () => {
    const session = durableStorageStub();
    const brokenLocal = {
      getItem: () => null,
      setItem: () => { throw new Error("local storage unavailable"); },
      removeItem: () => undefined,
      length: 0,
      key: () => null,
    };
    const pending = {
      uploadId: "upload-recovered-local",
      body: "old-body",
      ownerId: "account-a",
    } as const;
    const updated = { ...pending, body: "new-body" } as const;
    vi.stubGlobal("localStorage", brokenLocal);
    vi.stubGlobal("sessionStorage", session);
    persistPendingStorageUploadCompletion(pending);

    const local = durableStorageStub();
    vi.stubGlobal("localStorage", local);
    persistPendingStorageUploadCompletion(updated);

    expect(loadPendingStorageUploadCompletions("account-a")).toEqual([updated]);
    expect(session.getItem(
      "beutl.storage-upload-completions.v1:account-a:upload-recovered-local",
    )).toBeNull();
  });

  it("ignores one corrupt receipt without hiding its valid sibling", () => {
    const storage = durableStorageStub();
    const pending = {
      uploadId: "upload-valid-sibling",
      body: "{}",
      ownerId: "account-a",
    } as const;
    persistPendingStorageUploadCompletion(pending, storage);
    storage.setItem(
      `${"beutl.storage-upload-completions.v1"}:account-a:upload-corrupt`,
      "{not-json",
    );

    expect(loadPendingStorageUploadCompletions("account-a", storage)).toEqual([
      pending,
    ]);
  });

  it("keeps a malformed 200 completion receipt for retry", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("sessionStorage", durableStorageStub());
    const storage = durableStorageStub();
    const pending = {
      uploadId: "upload-malformed-completion",
      body: "{}",
      ownerId: "account-a",
    } as const;
    persistPendingStorageUploadCompletion(pending, storage);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "", size: -1 }), { status: 200 }),
    );

    const result = resumeStorageUploadCompletion(pending);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual({
      ok: false,
      errorCode: "uploadFailed",
      pendingCompletion: pending,
    });
    expect(loadPendingStorageUploadCompletions("account-a", storage)).toEqual([
      pending,
    ]);
  });

  it("isolates receipts between accounts sharing localStorage", () => {
    const storage = durableStorageStub();
    const first = { uploadId: "upload-account-a", body: "{}" } as const;
    const second = { uploadId: "upload-account-b", body: "{}" } as const;
    persistPendingStorageUploadCompletion({ ...first, ownerId: "account-a" }, storage);
    persistPendingStorageUploadCompletion({ ...second, ownerId: "account-b" }, storage);

    expect(loadPendingStorageUploadCompletions("account-b", storage)).toEqual([
      { ...second, ownerId: "account-b" },
    ]);
    discardPendingStorageUploadCompletion(
      first.uploadId,
      "account-b",
      storage,
    );
    expect(loadPendingStorageUploadCompletions("account-a", storage)).toEqual([
      { ...first, ownerId: "account-a" },
    ]);
    expect(loadPendingStorageUploadCompletions("account-b", storage)).toEqual([
      { ...second, ownerId: "account-b" },
    ]);
  });

  it("resumes a handle loaded by a remounted page", async () => {
    const storage = storageStub();
    vi.stubGlobal("sessionStorage", storage);
    const handle = { uploadId: "upload-remounted", body: "{}", ownerId: "account-a" } as const;
    const ownedHandle = { ...handle, ownerId: "account-a" };
    persistPendingStorageUploadCompletion(ownedHandle, storage);
    const loaded = loadPendingStorageUploadCompletions("account-a", storage);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "file-remounted", name: "a", size: 1 }), {
        status: 200,
      }),
    );
    await expect(resumeStorageUploadCompletion(loaded[0]!)).resolves.toMatchObject({
      ok: true,
      file: { id: "file-remounted" },
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("upload-remounted");
    expect(loadPendingStorageUploadCompletions("account-a", storage)).toEqual([]);
  });

  it("locks double invocation before the picker promise resolves", () => {
    const lock = { current: false };
    expect(tryAcquireStorageUploadLock(lock)).toBe(true);
    expect(tryAcquireStorageUploadLock(lock)).toBe(false);
    releaseStorageUploadLock(lock);
    expect(tryAcquireStorageUploadLock(lock)).toBe(true);
  });

  it("resolves a cancelled picker and releases the surrounding upload lock", async () => {
    type Listener = () => void;
    const listeners = new Map<string, Listener>();
    const input = {
      type: "",
      accept: "",
      multiple: false,
      files: null,
      onchange: null as Listener | null,
      addEventListener: (type: string, listener: Listener) =>
        listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
      click: () => listeners.get("cancel")?.(),
    };
    vi.stubGlobal("document", { createElement: () => input });
    const lock = { current: false };

    await expect(
      withStorageUploadLock(lock, () => showOpenFileDialog()),
    ).resolves.toBeNull();
    expect(lock.current).toBe(false);
    await expect(
      withStorageUploadLock(lock, async () => "next-click"),
    ).resolves.toBe("next-click");
  });

  it("releases the upload lock when the picker path throws", async () => {
    vi.stubGlobal("document", {
      createElement: () => ({
        type: "",
        accept: "",
        multiple: false,
        files: null,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        click() {
          throw new Error("dialog failed");
        },
      }),
    });
    const lock = { current: false };
    await expect(
      withStorageUploadLock(lock, () => showOpenFileDialog()),
    ).rejects.toThrow("dialog failed");
    expect(lock.current).toBe(false);
  });

  it("retains uploadFailed from a 400 response", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("sessionStorage", durableStorageStub());
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error_code: "uploadFailed" }), { status: 400 }),
    );
    const pending = { uploadId: "upload-400", body: "{}", ownerId: "account-a" } as const;
    const result = resumeStorageUploadCompletion(pending);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual({
      ok: false,
      errorCode: "uploadFailed",
      pendingCompletion: pending,
    });
  });
});
