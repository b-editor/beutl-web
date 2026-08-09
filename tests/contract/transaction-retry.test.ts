import { describe, expect, it, vi } from "vitest";
import { setDbProvider, startTransaction } from "@beutl/db";

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

    const result = await startTransaction(async () => "completed");

    expect(result).toBe("completed");
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-conflict failures", async () => {
    const transaction = vi.fn().mockRejectedValue(new Error("invalid data"));
    setDbProvider(async () => ({ $transaction: transaction }) as never);

    await expect(startTransaction(async () => "unused")).rejects.toThrow(
      "invalid data",
    );
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

    const result = await startTransaction(async () => "completed");

    expect(result).toBe("completed");
    expect(transaction).toHaveBeenCalledTimes(2);
  });
});
