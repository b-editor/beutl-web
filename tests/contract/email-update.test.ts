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
  transaction: { kind: "transaction" },
  getLanguage: vi.fn(async () => "en"),
  updateCustomerEmailIfExist: vi.fn(),
  updateUserEmail: vi.fn(),
  validateConfirmationToken: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@beutl/email", () => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/auth-guard", () => ({ authenticated: vi.fn() }));
vi.mock("@beutl/i18n", () => ({ getTranslation: vi.fn() }));
vi.mock("@beutl/next/language", () => ({ getLanguage: mocks.getLanguage }));
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
      emailChanged: "emailChanged",
      sentEmailChangeConfirmation: "sentEmailChangeConfirmation",
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

describe("email update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const tokenResult = {
      valid: true,
      tokenData: {
        userId: "user-id",
        identifier: "new@example.com",
      },
    };
    mocks.consumeConfirmationToken.mockResolvedValue(tokenResult);
    mocks.validateConfirmationToken.mockResolvedValue(tokenResult);
    mocks.startTransaction.mockImplementation(
      async (callback: (transaction: unknown) => Promise<unknown>) =>
        await callback({ kind: "transaction" }),
    );
    mocks.updateUserEmail.mockResolvedValue(undefined);
  });

  it("keeps the committed email update when Stripe synchronization fails", async () => {
    mocks.updateCustomerEmailIfExist.mockRejectedValue(
      new Error("Stripe unavailable"),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(updateEmail("token", "new@example.com")).rejects.toMatchObject({
      url: "/en/dashboard/account/email?status=emailUpdated",
    });
    expect(mocks.startTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.updateCustomerEmailIfExist).toHaveBeenCalledWith({
      userId: "user-id",
      email: "new@example.com",
    });
    expect(mocks.addAuditLog).toHaveBeenCalledWith({
      userId: "user-id",
      action: "emailChanged",
      details: "email: new@example.com, stripeCustomerEmailSync: failed",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      "/en/dashboard/account/email",
    );
    log.mockRestore();
  });
});
