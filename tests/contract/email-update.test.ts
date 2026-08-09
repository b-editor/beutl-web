import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addAuditLog: vi.fn(),
  consumeConfirmationToken: vi.fn(),
  getLanguage: vi.fn(),
  revalidatePath: vi.fn(),
  startTransaction: vi.fn(),
  transaction: { kind: "transaction" },
  synchronizeMappedStripeCustomer: vi.fn(),
  updateUserEmail: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/resend", () => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/auth-guard", () => ({ authenticated: vi.fn() }));
vi.mock("@beutl/i18n", () => ({ getTranslation: vi.fn() }));
vi.mock("@/lib/lang-utils", () => ({ getLanguage: mocks.getLanguage }));
vi.mock("@beutl/db", () => ({
  existsUserByEmail: vi.fn(),
  existsUserById: vi.fn(),
  startTransaction: mocks.startTransaction,
  updateUserEmail: mocks.updateUserEmail,
}));
vi.mock("@/lib/customer", () => ({
  synchronizeMappedStripeCustomer: mocks.synchronizeMappedStripeCustomer,
}));
vi.mock("@/lib/audit-log", () => ({
  addAuditLog: mocks.addAuditLog,
  auditLogActions: {
    account: {
      emailChanged: "emailChanged",
      sentEmailChangeConfirmation: "sentEmailChangeConfirmation",
    },
  },
}));
vi.mock("@/lib/confirmation-token-flow", () => ({
  consumeConfirmationToken: mocks.consumeConfirmationToken,
  issueConfirmationToken: vi.fn(),
}));

import { updateEmail } from "../../apps/web/src/app/[lang]/(manage-account)/account/manage/email/actions";

describe("email update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLanguage.mockResolvedValue("en");
    mocks.consumeConfirmationToken.mockResolvedValue({
      valid: true,
      tokenData: {
        userId: "user-id",
        identifier: "new@example.com",
      },
    });
    mocks.startTransaction.mockImplementation(async (callback) =>
      callback(mocks.transaction),
    );
    mocks.updateUserEmail.mockResolvedValue(undefined);
  });

  it("reports failure and skips success effects when Stripe rejects", async () => {
    mocks.synchronizeMappedStripeCustomer.mockRejectedValue(
      new Error("Stripe unavailable"),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let redirectError: unknown;

    try {
      await updateEmail("token", "new@example.com");
    } catch (error) {
      redirectError = error;
    } finally {
      log.mockRestore();
    }

    expect(redirectError).toMatchObject({
      message: "NEXT_REDIRECT",
      digest: expect.stringContaining("status=emailUpdateFailed"),
    });
    expect(mocks.startTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.synchronizeMappedStripeCustomer).toHaveBeenCalledWith({
      userId: "user-id",
      email: "new@example.com",
      prisma: mocks.transaction,
    });
    expect(mocks.addAuditLog).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
