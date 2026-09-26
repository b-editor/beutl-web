import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: { user: { id: "admin-1" } },
  setPackagePublishedByAdmin: vi.fn(),
  setReleasePublishedByAdmin: vi.fn(),
  revokeAllUserSessions: vi.fn(),
  existsUserById: vi.fn(),
  addAuditLog: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/auth-guard", () => ({
  adminAction: async (fnc: (session: unknown) => Promise<unknown>) => await fnc(mocks.session),
}));
vi.mock("@beutl/next/audit-log", async () => ({
  addAuditLog: mocks.addAuditLog,
  auditLogActions: (await import("../../packages/db/src/audit-log")).auditLogActions,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@beutl/db", () => ({
  setPackagePublishedByAdmin: mocks.setPackagePublishedByAdmin,
  setReleasePublishedByAdmin: mocks.setReleasePublishedByAdmin,
  revokeAllUserSessions: mocks.revokeAllUserSessions,
  existsUserById: mocks.existsUserById,
  startRetryableTransaction: async (fn: (tx: unknown) => Promise<unknown>) => await fn({}),
}));
// users/[id]/actions.ts は削除やクレジット調整のために Stripe と課金の依存を持つ。
// ここで検証するのはセッション失効だけなので、読み込みだけ通す。
vi.mock("@beutl/api", () => ({}));
vi.mock("stripe", () => ({ default: class {} }));

import {
  setPackagePublishedByAdmin,
  setReleasePublishedByAdmin,
} from "../../packages/db/src/admin-package";
import { revokeAllUserSessions } from "../../packages/db/src/admin-user-security";
import { findPackageForLibraryResponse } from "../../packages/db/src/package";
import { findReleaseForLibrary } from "../../packages/db/src/release";
import {
  setPackagePublished,
  setReleasePublished,
} from "../../apps/admin/src/app/[lang]/admin/packages/actions";
import { revokeUserSessions } from "../../apps/admin/src/app/[lang]/admin/users/[id]/actions";

const REASON = "Malware reported by users";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("administrator package visibility (db)", () => {
  function fakePrisma(model: "package" | "release", { count, row }: { count: number; row: unknown }) {
    return {
      [model]: {
        updateMany: vi.fn().mockResolvedValue({ count }),
        findUnique: vi.fn().mockResolvedValue(row),
      },
    };
  }

  it("reports a change only when the stored visibility differed", async () => {
    const changed = fakePrisma("package", { count: 1, row: { name: "pkg" } });
    await expect(
      setPackagePublishedByAdmin({ packageId: "p1", published: false, prisma: changed as never }),
    ).resolves.toEqual({ name: "pkg", changed: true });
    expect(changed.package.updateMany).toHaveBeenCalledWith({
      where: { id: "p1", published: true },
      data: { published: false },
    });

    const unchanged = fakePrisma("package", { count: 0, row: { name: "pkg" } });
    await expect(
      setPackagePublishedByAdmin({ packageId: "p1", published: false, prisma: unchanged as never }),
    ).resolves.toEqual({ name: "pkg", changed: false });
  });

  it("only publishes a release that has a file", async () => {
    const prisma = fakePrisma("release", {
      count: 0,
      row: { packageId: "p1", version: "1.0.0", published: false, fileId: null },
    });
    await expect(
      setReleasePublishedByAdmin({ releaseId: "r1", published: true, prisma: prisma as never }),
    ).resolves.toEqual({ packageId: "p1", version: "1.0.0", changed: false, missingFile: true });
    expect(prisma.release.updateMany).toHaveBeenCalledWith({
      where: { id: "r1", published: false, fileId: { not: null } },
      data: { published: true },
    });
  });

  it("returns null for a package or release that does not exist", async () => {
    const pkg = fakePrisma("package", { count: 0, row: null });
    await expect(
      setPackagePublishedByAdmin({ packageId: "missing", published: true, prisma: pkg as never }),
    ).resolves.toBeNull();
    const release = fakePrisma("release", { count: 0, row: null });
    await expect(
      setReleasePublishedByAdmin({ releaseId: "missing", published: true, prisma: release as never }),
    ).resolves.toBeNull();
  });
});

describe("administrator package visibility (actions)", () => {
  it("requires a reason before touching the package", async () => {
    await expect(
      setPackagePublished({ packageId: "p1", published: false, reason: "bad" }),
    ).resolves.toEqual({ success: false, message: "Invalid input" });
    await expect(
      setPackagePublished({ packageId: "p1", published: "false", reason: REASON }),
    ).resolves.toEqual({ success: false, message: "Invalid input" });
    expect(mocks.setPackagePublishedByAdmin).not.toHaveBeenCalled();
  });

  it("records the reason in the audit log when the visibility changes", async () => {
    mocks.setPackagePublishedByAdmin.mockResolvedValue({ name: "pkg", changed: true });
    await expect(
      setPackagePublished({ packageId: "p1", published: false, reason: `  ${REASON}  ` }),
    ).resolves.toEqual({ success: true });
    expect(mocks.addAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        action: "admin.packageUnpublished",
        details: `packageId: p1, name: pkg, reason: ${REASON}`,
      }),
    );
  });

  it("does not log a change that did not happen", async () => {
    mocks.setReleasePublishedByAdmin.mockResolvedValue({ packageId: "p1", version: "1.0.0", changed: false, missingFile: false });
    await expect(
      setReleasePublished({ releaseId: "r1", published: true, reason: REASON }),
    ).resolves.toEqual({ success: true });
    expect(mocks.addAuditLog).not.toHaveBeenCalled();
  });

  it("refuses to publish a release without a file", async () => {
    mocks.setReleasePublishedByAdmin.mockResolvedValue({
      packageId: "p1",
      version: "1.0.0",
      changed: false,
      missingFile: true,
    });
    await expect(
      setReleasePublished({ releaseId: "r1", published: true, reason: REASON }),
    ).resolves.toEqual({ success: false, message: "A release without a file cannot be published" });
    expect(mocks.addAuditLog).not.toHaveBeenCalled();
  });

  it("reports a missing release", async () => {
    mocks.setReleasePublishedByAdmin.mockResolvedValue(null);
    await expect(
      setReleasePublished({ releaseId: "r1", published: false, reason: REASON }),
    ).resolves.toEqual({ success: false, message: "Release not found" });
  });
});

describe("administrator session revocation", () => {
  it("deletes web sessions and revokes only live desktop families", async () => {
    const now = new Date("2026-09-25T00:00:00.000Z");
    const prisma = {
      session: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
      refreshTokenFamily: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    await expect(
      revokeAllUserSessions({ userId: "user-1", now, prisma: prisma as never }),
    ).resolves.toEqual({ sessions: 2, refreshTokenFamilies: 1 });
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(prisma.refreshTokenFamily.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", revokedAt: null },
      data: { revokedAt: now },
    });
  });

  it("refuses to sign the administrator out of their own console", async () => {
    await expect(revokeUserSessions({ userId: "admin-1" })).resolves.toEqual({
      success: false,
      message: "You cannot revoke your own sessions here",
    });
    expect(mocks.revokeAllUserSessions).not.toHaveBeenCalled();
  });

  it("reports a missing user without writing an audit entry", async () => {
    mocks.existsUserById.mockResolvedValue(false);
    await expect(revokeUserSessions({ userId: "user-1" })).resolves.toEqual({
      success: false,
      message: "User not found",
    });
    expect(mocks.revokeAllUserSessions).not.toHaveBeenCalled();
    expect(mocks.addAuditLog).not.toHaveBeenCalled();
  });

  it("records what was revoked", async () => {
    mocks.existsUserById.mockResolvedValue(true);
    mocks.revokeAllUserSessions.mockResolvedValue({ sessions: 3, refreshTokenFamilies: 2 });
    await expect(revokeUserSessions({ userId: "user-1" })).resolves.toEqual({ success: true });
    expect(mocks.addAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        action: "admin.userSessionsRevoked",
        details: "userId: user-1, sessions: 3, refreshTokenFamilies: 2",
      }),
    );
  });
});

describe("library responses after a release is unpublished", () => {
  it("only considers published releases when picking the latest", async () => {
    const prisma = { package: { findFirst: vi.fn().mockResolvedValue(null) } };
    await findPackageForLibraryResponse({ id: "p1", currency: null, prisma: prisma as never });
    expect(prisma.package.findFirst.mock.calls[0][0].select.Release.where).toEqual({ published: true });
  });

  it("refuses to hand out an unpublished release", async () => {
    const prisma = { release: { findFirst: vi.fn().mockResolvedValue(null) } };
    await findReleaseForLibrary({ id: "r1", prisma: prisma as never });
    expect(prisma.release.findFirst.mock.calls[0][0].where).toEqual({ id: "r1", published: true });
  });
});
