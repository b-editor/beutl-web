import { createRequire } from "node:module";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect:${url}`);
  }
}

const mocks = vi.hoisted(() => ({
  addAuditLog: vi.fn(),
  consumeConfirmationToken: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new RedirectSignal(url);
  }),
  revalidatePath: vi.fn(),
  startTransaction: vi.fn(),
  updateCustomerEmailIfExist: vi.fn(),
  updateUserEmail: vi.fn(),
  validateConfirmationToken: vi.fn(),
}));

vi.mock("@/lib/auth-guard", () => ({ authenticated: vi.fn() }));
vi.mock("@beutl/next/language", () => ({
  getLanguage: vi.fn(async () => "en"),
}));
vi.mock("@/resend", () => ({ sendEmail: vi.fn() }));
vi.mock("@beutl/i18n", () => ({ getTranslation: vi.fn() }));
vi.mock("@beutl/db", () => ({
  existsUserByEmail: vi.fn(),
  existsUserById: vi.fn(),
  startTransaction: mocks.startTransaction,
  updateUserEmail: mocks.updateUserEmail,
}));
vi.mock("@/lib/customer", () => ({
  updateCustomerEmailIfExist: mocks.updateCustomerEmailIfExist,
}));
vi.mock("@beutl/next/audit-log", () => ({
  addAuditLog: mocks.addAuditLog,
  auditLogActions: {
    account: {
      emailChanged: "account.emailChanged",
      sentEmailChangeConfirmation: "account.sentEmailChangeConfirmation",
    },
  },
}));
vi.mock("@/lib/confirmation-token-flow", () => ({
  consumeConfirmationToken: mocks.consumeConfirmationToken,
  issueConfirmationToken: vi.fn(),
  validateConfirmationToken: mocks.validateConfirmationToken,
}));

let updateEmail: (token: string, identifier: string) => Promise<void>;

beforeAll(async () => {
  const requireFromWeb = createRequire(
    new URL("../../apps/web/package.json", import.meta.url),
  );
  vi.doMock(requireFromWeb.resolve("next/navigation"), () => ({
    redirect: mocks.redirect,
    RedirectType: { replace: "replace" },
  }));
  vi.doMock(requireFromWeb.resolve("next/cache"), () => ({
    revalidatePath: mocks.revalidatePath,
  }));
  vi.doMock(requireFromWeb.resolve("next/headers"), () => ({
    headers: vi.fn(async () => new Headers()),
  }));
  ({ updateEmail } = await import(
    "../../apps/web/src/app/[lang]/(dashboard)/dashboard/account/email/actions"
  ));
});

describe("email update billing synchronization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const tokenResult = {
      valid: true,
      tokenData: {
        identifier: "new@example.com",
        userId: "user-1",
      },
    };
    mocks.consumeConfirmationToken.mockResolvedValue(tokenResult);
    mocks.validateConfirmationToken.mockResolvedValue(tokenResult);
    mocks.startTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => {
        return await callback({ attempt: 1 });
      },
    );
    mocks.updateCustomerEmailIfExist.mockResolvedValue({
      status: "synced",
      customerId: "cus_1",
    });
  });

  it("runs Stripe synchronization once after a retried DB transaction commits", async () => {
    mocks.startTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => {
        await callback({ attempt: 1 });
        return await callback({ attempt: 2 });
      },
    );

    await expect(
      updateEmail("confirmation-token", "new@example.com"),
    ).rejects.toMatchObject({
      url: "/en/dashboard/account/email?status=emailUpdated",
    });

    expect(mocks.updateUserEmail).toHaveBeenCalledTimes(2);
    expect(mocks.updateCustomerEmailIfExist).toHaveBeenCalledTimes(1);
    expect(mocks.updateCustomerEmailIfExist).toHaveBeenCalledWith({
      userId: "user-1",
      email: "new@example.com",
    });
    expect(mocks.updateUserEmail.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.updateCustomerEmailIfExist.mock.invocationCallOrder[0],
    );
  });

  it("keeps the committed email and explicitly records a Stripe sync failure", async () => {
    const syncError = new Error("Stripe temporarily unavailable");
    mocks.updateCustomerEmailIfExist.mockRejectedValue(syncError);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      updateEmail("confirmation-token", "new@example.com"),
    ).rejects.toMatchObject({
      url: "/en/dashboard/account/email?status=emailUpdated",
    });

    expect(consoleError).toHaveBeenCalledWith(
      "Stripe customer email synchronization failed",
      { userId: "user-1", error: syncError },
    );
    expect(mocks.addAuditLog).toHaveBeenCalledWith({
      userId: "user-1",
      action: "account.emailChanged",
      details:
        "email: new@example.com, stripeCustomerEmailSync: failed",
    });
  });

  it("does not call Stripe when the local DB transaction fails", async () => {
    mocks.startTransaction.mockRejectedValue(new Error("database unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      updateEmail("confirmation-token", "new@example.com"),
    ).rejects.toMatchObject({
      url: "/en/dashboard/account/email?status=emailUpdateFailed",
    });
    expect(mocks.updateCustomerEmailIfExist).not.toHaveBeenCalled();
    expect(mocks.consumeConfirmationToken).not.toHaveBeenCalled();
  });

  it("does not update the email when the token loses the consume race", async () => {
    mocks.consumeConfirmationToken.mockResolvedValue({
      valid: false,
      reason: "invalid",
    });

    await expect(
      updateEmail("confirmation-token", "new@example.com"),
    ).rejects.toMatchObject({
      url: "/en/dashboard/account/email?status=emailUpdateFailed",
    });

    expect(mocks.updateUserEmail).not.toHaveBeenCalled();
    expect(mocks.updateCustomerEmailIfExist).not.toHaveBeenCalled();
  });
});
