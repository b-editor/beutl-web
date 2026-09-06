import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "@beutl/core";
import { setDbProvider } from "@beutl/db";
import {
  consumeConfirmationToken,
  validateConfirmationToken,
} from "../../apps/web/src/lib/confirmation-token-flow";

describe("confirmation token claiming", () => {
  const rawToken = "raw-confirmation-token";
  const identifier = "owner@example.com";
  let record: {
    token: string;
    identifier: string;
    userId: string;
    purpose: string;
    expires: Date;
  } | null;

  beforeEach(async () => {
    process.env.AUTH_SECRET = "confirmation-test-secret";
    record = {
      token: await createHash(`${rawToken}${process.env.AUTH_SECRET}`),
      identifier,
      userId: "user-1",
      purpose: "ACCOUNT_DELETE",
      expires: new Date(Date.now() + 60_000),
    };
    setDbProvider(async () => ({
      confirmationToken: {
        findUnique: async ({ where }: { where: { identifier_token: object } }) => {
          const key = where.identifier_token as {
            identifier: string;
            token: string;
          };
          return record?.identifier === key.identifier && record.token === key.token
            ? { ...record }
            : null;
        },
        deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
          if (
            record &&
            record.identifier === where.identifier &&
            record.token === where.token &&
            record.purpose === where.purpose &&
            record.userId === where.userId &&
            record.expires > (where.expires as { gt: Date }).gt
          ) {
            record = null;
            return { count: 1 };
          }
          return { count: 0 };
        },
      },
    }) as never);
  });

  afterEach(() => {
    delete process.env.AUTH_SECRET;
  });

  it("validates without consuming so an external retry can reuse the link", async () => {
    const first = await validateConfirmationToken({
      token: rawToken,
      identifier,
      purpose: "ACCOUNT_DELETE" as never,
    });
    const second = await validateConfirmationToken({
      token: rawToken,
      identifier,
      purpose: "ACCOUNT_DELETE" as never,
    });

    expect(first.valid).toBe(true);
    expect(second.valid).toBe(true);
    expect(record).not.toBeNull();
  });

  it("consumes exactly once after the external operation succeeds", async () => {
    const options = {
      token: rawToken,
      identifier,
      purpose: "ACCOUNT_DELETE" as never,
    };

    await expect(consumeConfirmationToken(options)).resolves.toMatchObject({
      valid: true,
    });
    await expect(consumeConfirmationToken(options)).resolves.toEqual({
      valid: false,
      reason: "invalid",
    });
  });

  it("does not delete a token for a different purpose", async () => {
    await expect(
      consumeConfirmationToken({
        token: rawToken,
        identifier,
        purpose: "EMAIL_UPDATE" as never,
      }),
    ).resolves.toEqual({ valid: false, reason: "invalid" });
    expect(record).not.toBeNull();
  });

  it("fails closed when the confirmation secret is missing", async () => {
    delete process.env.AUTH_SECRET;

    await expect(
      validateConfirmationToken({
        token: rawToken,
        identifier,
        purpose: "ACCOUNT_DELETE" as never,
      }),
    ).rejects.toThrow("AUTH_SECRET is not configured");
  });
});
