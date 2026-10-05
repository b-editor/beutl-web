import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileUserNameTakenError, setDbProvider, upsertProfile } from "@beutl/db";

vi.mock("@/lib/auth-guard", () => ({ authenticated: async (fn: (session: unknown) => unknown) => fn({ user: { id: "owner" } }) }));
vi.mock("@beutl/next/language", () => ({ getLanguage: async () => "en" }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { revalidatePath } from "next/cache";
vi.mock("@beutl/next/audit-log", () => ({ addAuditLog: vi.fn(), auditLogActions: { authjs: { createUser: "createUser" } } }));
import { updateProfile } from "../../apps/web/src/app/[lang]/(dashboard)/dashboard/account/profile/actions";
import { onUserCreated } from "../../packages/next/src/auth-hooks";

describe("publisher identity", () => {
  const profile = {
    findFirst: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), create: vi.fn(),
  };
  const socialProfile = { upsert: vi.fn(), deleteMany: vi.fn() };
  const models = {
    profile, socialProfile,
    socialProfileProvider: { findMany: vi.fn(async () => [{ id: "github", provider: "github" }]) },
  };
  beforeEach(() => {
    vi.clearAllMocks();
    profile.findFirst.mockReset().mockResolvedValue(null);
    profile.findUnique.mockReset().mockResolvedValue(null);
    profile.create.mockReset().mockResolvedValue({});
    profile.upsert.mockReset().mockResolvedValue({});
    setDbProvider(async () => ({
      ...models,
      $transaction: async (fn: (tx: typeof models) => unknown) => fn(models),
    }) as never);
  });
  const change = () => upsertProfile({ userId: "owner", userName: "Publisher", displayName: "Name" });
  function form(userName = "Publisher") {
    const data = new FormData();
    data.set("displayName", "Name");
    data.set("userName", userName);
    data.set("github", "new-social-value");
    return data;
  }
  it("rejects an existing name and its case variants owned by another user", async () => {
    profile.findFirst.mockResolvedValue({ userId: "other" });
    await expect(change()).rejects.toBeInstanceOf(ProfileUserNameTakenError);
    expect(profile.findFirst).toHaveBeenCalledWith({
      where: { userName: { equals: "Publisher", mode: "insensitive" }, userId: { not: "owner" } },
      select: { userId: true },
    });
    expect(profile.upsert).not.toHaveBeenCalled();
  });
  it("allows keeping one's own name and spelling", async () => {
    await expect(change()).resolves.toEqual({});
    expect(profile.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "owner" }, update: expect.objectContaining({ userName: "Publisher" }),
    }));
  });
  it("reports a concurrent unique-index conflict as a name conflict", async () => {
    profile.upsert.mockRejectedValue({ code: "P2002" });
    await expect(change()).rejects.toBeInstanceOf(ProfileUserNameTakenError);
  });
  it("does not misreport a database outage as a taken name", async () => {
    profile.upsert.mockRejectedValue(new Error("Database unavailable"));
    await expect(change()).rejects.toThrow("Database unavailable");
  });
  it.each(["existing", "racing"])("returns a localized field error without changing socials: %s", async (kind) => {
    if (kind === "existing") profile.findFirst.mockResolvedValue({ userId: "other" });
    else profile.upsert.mockRejectedValue({ code: "P2002" });
    expect(await updateProfile({}, form())).toMatchObject({
      success: false, errors: { userName: ["This user ID is already in use"] },
    });
    expect(socialProfile.upsert).not.toHaveBeenCalled();
    expect(socialProfile.deleteMany).not.toHaveBeenCalled();
  });
  it("updates socials only after accepting the profile identity", async () => {
    expect((await updateProfile({}, form())).success).toBe(true);
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(socialProfile.upsert).toHaveBeenCalledWith({
      where: { userId_providerId: { userId: "owner", providerId: "github" } },
      update: { value: "new-social-value" },
      create: { userId: "owner", providerId: "github", value: "new-social-value" },
    });
  });
  it.each(["john^doe", "john.doe", "john+tag"])("preserves an unchanged signup-generated name while saving the profile: %s", async (userName) => {
    profile.findFirst.mockImplementation(async ({ where }) =>
      where.userId === "owner" ? { userId: "owner", userName } : null);
    expect((await updateProfile({}, form(userName))).success).toBe(true);
    expect(profile.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ userName, displayName: "Name" }),
    }));
    expect(socialProfile.upsert).toHaveBeenCalledOnce();
  });
  it.each(["john^doe", "john.doe", "john+tag", ""])("still validates changed usernames: %s", async (userName) => {
    profile.findFirst.mockImplementation(async ({ where }) =>
      where.userId === "owner" ? { userId: "owner", userName: "Publisher" } : null);
    expect(await updateProfile({}, form(userName))).toMatchObject({
      success: false, errors: { userName: expect.any(Array) },
    });
    expect(profile.upsert).not.toHaveBeenCalled();
    expect(socialProfile.upsert).not.toHaveBeenCalled();
  });
  it("skips names taken with different casing during signup", async () => {
    profile.findFirst.mockResolvedValueOnce({ userId: "other" });
    await onUserCreated({ id: "new-owner", email: "Publisher@example.com" });
    expect(profile.create).toHaveBeenCalledWith({ data: {
      userId: "new-owner", displayName: "Publisher1", userName: "Publisher1",
    } });
  });
  it("retries a signup name if another writer claims it after the lookup", async () => {
    profile.create.mockRejectedValueOnce({ code: "P2002" });
    await onUserCreated({ id: "new-owner", email: "Publisher@example.com" });
    expect(profile.create).toHaveBeenCalledTimes(2);
    expect(profile.create.mock.calls[1][0].data.userName).toBe("Publisher1");
  });
  it("stops when a repeated signup hook finds its profile already created", async () => {
    profile.create.mockRejectedValueOnce({ code: "P2002" });
    profile.findUnique.mockResolvedValue({ userId: "new-owner" });
    await onUserCreated({ id: "new-owner", email: "Publisher@example.com" });
    expect(profile.create).toHaveBeenCalledTimes(1);
  });
});
