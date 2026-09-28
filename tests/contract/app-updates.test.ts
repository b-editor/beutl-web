import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  findAppReleaseAsset: vi.fn(),
  findAppReleaseAssetVersions: vi.fn(),
}));

vi.mock("@beutl/db", () => db);
vi.mock("../../packages/api/src/api/error", () => ({
  apiErrorResponse: async (code: string) => ({ error_code: code }),
}));

import app from "../../packages/api/src/v3/app";

beforeEach(() => {
  vi.resetAllMocks();
  db.findAppReleaseAssetVersions.mockResolvedValue([{ version: "2.0.0" }]);
});

describe("registered application updates", () => {
  it.each(["zip", "debian", "installer", "app", "flatpak"])(
    "returns the registered URL for type=%s through the same update endpoint",
    async (type) => {
      const url = `https://downloads.example.test/assets/${type}?token=registered`;
      db.findAppReleaseAsset.mockResolvedValue({ url, minVersion: null });

      const response = await app.request(
        `/updates/1.0.0?type=${type}&os=linux&arch=x64&standalone=true`,
      );

      expect(response.status).toBe(200);
      expect(db.findAppReleaseAsset).toHaveBeenCalledExactlyOnceWith({
        version: "2.0.0", type, os: "linux", arch: "x64", standalone: true,
      });
      expect(await response.json()).toEqual({
        latestVersion: "2.0.0",
        url: "https://github.com/b-editor/beutl/releases/tag/v2.0.0",
        downloadUrl: url,
        isLatest: false,
        mustLatest: false,
      });
    },
  );

  it("does not substitute a ZIP when no Flatpak asset is registered", async () => {
    db.findAppReleaseAsset.mockResolvedValue(null);
    const response = await app.request(
      "/updates/1.0.0?type=flatpak&os=linux&arch=x64&standalone=true",
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error_code: "assetNotFound" });
    expect(db.findAppReleaseAsset).toHaveBeenCalledExactlyOnceWith({
      version: "2.0.0", type: "flatpak", os: "linux", arch: "x64", standalone: true,
    });
  });

  it("reports an up-to-date Flatpak without requesting a download", async () => {
    const response = await app.request(
      "/updates/2.0.0?type=flatpak&os=linux&arch=x64&standalone=true",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ isLatest: true, downloadUrl: null });
    expect(db.findAppReleaseAsset).not.toHaveBeenCalled();
  });

  it("preserves the minimum-version requirement of the registered Flatpak", async () => {
    db.findAppReleaseAsset.mockResolvedValue({
      url: "https://downloads.example.test/registered.flatpak", minVersion: "1.5.0",
    });
    const response = await app.request(
      "/updates/1.0.0?type=flatpak&os=linux&arch=x64&standalone=true",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mustLatest: true });
  });

  it("continues to reject unknown package types", async () => {
    const response = await app.request(
      "/updates/1.0.0?type=unknown&os=linux&arch=x64&standalone=true",
    );

    expect(response.status).toBe(400);
    expect(db.findAppReleaseAssetVersions).not.toHaveBeenCalled();
    expect(db.findAppReleaseAsset).not.toHaveBeenCalled();
  });
});
