import { beforeEach, describe, expect, it, vi } from "vitest";
import { profileDisplayName } from "@beutl/core";
import {
  getPackageDetailForAdmin,
  getUserDetail,
  listPackagesForAdmin,
  listSubscriptionsForAdmin,
  listUserLabels,
  listUsers,
  setDbProvider,
} from "@beutl/db";

const profile = { displayName: "Profile Name", userName: "profile-owner" };
const user = {
  id: "owner",
  name: "Provider Name",
  email: "owner@example.com",
  Profile: profile,
};
const pkg = { id: "package-1", name: "package", user };
const db = {
  user: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
  package: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
  subscription: { findMany: vi.fn(), count: vi.fn() },
};

beforeEach(() => {
  vi.clearAllMocks();
  db.user.findMany.mockResolvedValue([user]);
  db.user.findUnique.mockResolvedValue(user);
  db.user.count.mockResolvedValue(1);
  db.package.findMany.mockResolvedValue([pkg]);
  db.package.findUnique.mockResolvedValue(pkg);
  db.package.count.mockResolvedValue(1);
  db.subscription.findMany.mockResolvedValue([{ userId: user.id, user }]);
  db.subscription.count.mockResolvedValue(1);
  setDbProvider(async () => db as never);
});

describe("profile display names", () => {
  it.each(["", "   ", "　"])("uses the profile username when the display name is %j", (displayName) => {
    expect(profileDisplayName({ ...profile, displayName })).toBe(profile.userName);
  });

  it("leaves a missing profile unnamed", () => {
    expect(profileDisplayName(null)).toBeNull();
  });

  it("displays and searches the saved profile in the admin user list", async () => {
    const result = await listUsers({ query: "Profile", page: 1, pageSize: 20 });
    expect(result.items[0].name).toBe(profile.displayName);
    const query = db.user.findMany.mock.calls[0][0];
    expect(query.select.Profile).toEqual({ select: { displayName: true, userName: true } });
    expect(query.select.name).toBeUndefined();
    expect(query.where.OR).toContainEqual({
      Profile: {
        is: {
          OR: [
            { displayName: { contains: "Profile", mode: "insensitive" } },
            { userName: { contains: "Profile", mode: "insensitive" } },
          ],
        },
      },
    });
    expect(db.user.count.mock.calls[0][0].where).toEqual(query.where);
  });

  it("uses the profile for user details and usage-report labels", async () => {
    expect((await getUserDetail({ userId: user.id }))?.name).toBe(profile.displayName);
    expect((await listUserLabels({ userIds: [user.id] }))[0].name).toBe(profile.displayName);
  });

  it("keeps a missing user detail empty", async () => {
    db.user.findUnique.mockResolvedValue(null);
    expect(await getUserDetail({ userId: "deleted" })).toBeNull();
  });

  it("uses the profile for package owners in the admin list and detail", async () => {
    expect((await listPackagesForAdmin({ page: 1, pageSize: 20 })).items[0].user.name).toBe(profile.displayName);
    expect((await getPackageDetailForAdmin({ packageId: pkg.id }))?.user.name).toBe(profile.displayName);
  });

  it("uses the profile for subscription owners", async () => {
    expect((await listSubscriptionsForAdmin({ page: 1, pageSize: 20 })).items[0].user.name).toBe(profile.displayName);
  });

  it("does not reintroduce a provider name in admin lists when the profile is missing", async () => {
    db.user.findMany.mockResolvedValue([{ ...user, Profile: null }]);
    expect((await listUsers({ page: 1, pageSize: 20 })).items[0].name).toBeNull();
  });
});
