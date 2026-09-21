import { describe, expect, it } from "vitest";
import {
  aiVideoResolutionOfGatewayLabel,
  gatewayVideoResolution,
} from "../../packages/api/src/ai/providers/vercel-gateway/resolution";

describe("the pixel size a Gateway request carries", () => {
  it("reproduces every size Vercel's own examples use", () => {
    // These are the sizes the provider pages spell out. If the arithmetic here
    // ever stops landing on them, requests start naming shapes no model was
    // documented to take.
    expect(gatewayVideoResolution("1080p", "16:9")).toBe("1920x1080");
    expect(gatewayVideoResolution("720p", "16:9")).toBe("1280x720");
    expect(gatewayVideoResolution("480p", "16:9")).toBe("854x480");
    expect(gatewayVideoResolution("2K", "16:9")).toBe("2560x1440");
  });

  it("stands the same label up for a portrait shape", () => {
    expect(gatewayVideoResolution("720p", "9:16")).toBe("720x1280");
    expect(gatewayVideoResolution("1080p", "9:16")).toBe("1080x1920");
    expect(gatewayVideoResolution("480p", "3:4")).toBe("480x640");
    expect(gatewayVideoResolution("720p", "4:3")).toBe("960x720");
    expect(gatewayVideoResolution("720p", "1:1")).toBe("720x720");
  });

  it("squares an unstated shape off against the one every model takes", () => {
    // A request naming no aspect ratio is priced and estimated as 16:9.
    expect(gatewayVideoResolution("720p", undefined)).toBe("1280x720");
  });

  it("keeps every dimension even", () => {
    // 480 x 16/9 is 853.33; an odd width is refused by encoders downstream.
    for (const resolution of ["480p", "720p", "1080p", "2K"]) {
      for (const ratio of ["16:9", "9:16", "4:3", "3:4", "1:1"]) {
        const size = gatewayVideoResolution(resolution, ratio);
        expect(size).not.toBeNull();
        const [width, height] = size!.split("x").map(Number);
        expect(width % 2).toBe(0);
        expect(height % 2).toBe(0);
      }
    }
  });

  it("refuses a pair this service does not offer", () => {
    expect(gatewayVideoResolution("4K", "16:9")).toBeNull();
    expect(gatewayVideoResolution("720p", "21:9")).toBeNull();
  });
});

describe("reading the provider's own resolution labels", () => {
  it("folds the provider's spellings onto this service's names", () => {
    // /v1/models publishes "2k" lowercase, and names two sizes twice.
    expect(aiVideoResolutionOfGatewayLabel("2k")).toBe("2K");
    expect(aiVideoResolutionOfGatewayLabel("2K")).toBe("2K");
    expect(aiVideoResolutionOfGatewayLabel("hd")).toBe("720p");
    expect(aiVideoResolutionOfGatewayLabel("fhd")).toBe("1080p");
    expect(aiVideoResolutionOfGatewayLabel("1080p")).toBe("1080p");
  });

  it("drops a size this service will not price", () => {
    // 4K is four times 1080p's pixels at a price set against 1080p, and 768p
    // has no name here at all.
    expect(aiVideoResolutionOfGatewayLabel("4k")).toBeNull();
    expect(aiVideoResolutionOfGatewayLabel("768p")).toBeNull();
  });
});
