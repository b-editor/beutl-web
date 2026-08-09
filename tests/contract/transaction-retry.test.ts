import { describe, expect, it, vi } from "vitest";
import {
  setDbProvider,
  startRetryableTransaction,
  startTransaction,
} from "@beutl/db";

describe("database transactions", () => {
  it("retries CockroachDB write conflicts", async () => {
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("write conflict"), { code: "P2034" }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("write conflict"), { code: "P2034" }),
      )
      .mockImplementation(async (callback) => callback({}));
    setDbProvider(async () => ({ $transaction: transaction }) as never);

    const result = await startRetryableTransaction(async () => "completed");

    expect(result).toBe("completed");
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-conflict failures", async () => {
    const transaction = vi.fn().mockRejectedValue(new Error("invalid data"));
    setDbProvider(async () => ({ $transaction: transaction }) as never);

    await expect(
      startRetryableTransaction(async () => "unused"),
    ).rejects.toThrow("invalid data");
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("retries adapter write conflicts raised while committing", async () => {
    const adapterConflict = Object.assign(
      new Error("TransactionWriteConflict"),
      {
        name: "DriverAdapterError",
        cause: { kind: "TransactionWriteConflict" },
      },
    );
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(adapterConflict)
      .mockImplementation(async (callback) => callback({}));
    setDbProvider(async () => ({ $transaction: transaction }) as never);

    const result = await startRetryableTransaction(async () => "completed");

    expect(result).toBe("completed");
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("does not replay ordinary transaction callbacks", async () => {
    const conflict = Object.assign(new Error("write conflict"), {
      code: "P2034",
    });
    const callback = vi.fn(async () => "unused");
    const transaction = vi.fn(async (run) => {
      await run({});
      throw conflict;
    });
    setDbProvider(async () => ({ $transaction: transaction }) as never);

    await expect(startTransaction(callback)).rejects.toBe(conflict);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
