import { describe, expect, it } from "vitest";
import {
  analyticsManifestV1MaxFeatures,
  analyticsManifestV1MaxTypeIdentifierCharacters,
  analyticsManifestV1MaxTypesPerFeature,
  AnalyticsManifestValidationError,
  parseAnalyticsManifestV1,
  parseAnalyticsManifestV1Json,
} from "@beutl/core";

function validManifest() {
  return {
    schemaVersion: 1,
    features: [
      {
        kind: "effect",
        key: "color-grade",
        types: [
          {
            assembly: "Example.Extension",
            type: "Example.Extension.ColorGrade",
          },
        ],
      },
    ],
  };
}

describe("Marketplace analytics manifest v1", () => {
  it("accepts a static canonical feature mapping", () => {
    expect(parseAnalyticsManifestV1(validManifest())).toEqual(validManifest());
  });

  it("rejects unknown fields and unsupported schema versions", () => {
    expect(() =>
      parseAnalyticsManifestV1({ ...validManifest(), extra: true }),
    ).toThrow(AnalyticsManifestValidationError);
    expect(() =>
      parseAnalyticsManifestV1({ ...validManifest(), schemaVersion: 2 }),
    ).toThrow(AnalyticsManifestValidationError);
    expect(() =>
      parseAnalyticsManifestV1({
        ...validManifest(),
        features: [{ ...validManifest().features[0], extra: true }],
      }),
    ).toThrow(AnalyticsManifestValidationError);
  });

  it("rejects noncanonical feature names", () => {
    expect(() =>
      parseAnalyticsManifestV1({
        ...validManifest(),
        features: [{ ...validManifest().features[0], kind: "Effect" }],
      }),
    ).toThrow(AnalyticsManifestValidationError);
    expect(() =>
      parseAnalyticsManifestV1({
        ...validManifest(),
        features: [{ ...validManifest().features[0], key: "color_grade" }],
      }),
    ).toThrow(AnalyticsManifestValidationError);
    expect(() =>
      parseAnalyticsManifestV1({
        ...validManifest(),
        features: [
          {
            ...validManifest().features[0],
            types: [
              {
                assembly: "Example..Extension",
                type: "Example.Extension.ColorGrade",
              },
            ],
          },
        ],
      }),
    ).toThrow(AnalyticsManifestValidationError);
  });

  it("rejects duplicate features and exact type mappings", () => {
    const manifest = validManifest();
    expect(() =>
      parseAnalyticsManifestV1({
        ...manifest,
        features: [manifest.features[0], manifest.features[0]],
      }),
    ).toThrow(AnalyticsManifestValidationError);

    expect(() =>
      parseAnalyticsManifestV1({
        ...manifest,
        features: [
          manifest.features[0],
          {
            kind: "filter",
            key: "color-grade",
            types: manifest.features[0].types,
          },
        ],
      }),
    ).toThrow(AnalyticsManifestValidationError);
  });

  it("enforces the feature and mapping limits", () => {
    expect(() =>
      parseAnalyticsManifestV1({
        schemaVersion: 1,
        features: Array.from(
          { length: analyticsManifestV1MaxFeatures + 1 },
          (_, index) => ({
            kind: "effect",
            key: `feature-${index}`,
            types: [
              {
                assembly: "Example.Extension",
                type: `Example.Extension.Feature${index}`,
              },
            ],
          }),
        ),
      }),
    ).toThrow(AnalyticsManifestValidationError);

    expect(() =>
      parseAnalyticsManifestV1({
        schemaVersion: 1,
        features: [
          {
            kind: "effect",
            key: "too-many-types",
            types: Array.from(
              { length: analyticsManifestV1MaxTypesPerFeature + 1 },
              (_, index) => ({
                assembly: "Example.Extension",
                type: `Example.Extension.Feature${index}`,
              }),
            ),
          },
        ],
      }),
    ).toThrow(AnalyticsManifestValidationError);
  });

  it.each(["assembly", "type"] as const)(
    "accepts 256 decoded characters and rejects 257 for %s",
    (field) => {
      const accepted = `A${"a".repeat(
        analyticsManifestV1MaxTypeIdentifierCharacters - 1,
      )}`;
      const rejected = `${accepted}a`;
      const manifest = validManifest();
      manifest.features[0].types[0][field] = accepted;
      expect(parseAnalyticsManifestV1(manifest)).toEqual(manifest);
      manifest.features[0].types[0][field] = rejected;
      expect(() => parseAnalyticsManifestV1(manifest)).toThrow(
        AnalyticsManifestValidationError,
      );
    },
  );

  it("applies identifier length after JSON Unicode escape decoding", () => {
    const escaped = "\\u0041" + "\\u0061".repeat(
      analyticsManifestV1MaxTypeIdentifierCharacters - 1,
    );
    const source = `{"schemaVersion":1,"features":[{"kind":"effect","key":"escaped","types":[{"assembly":"${escaped}","type":"${escaped}"}]}]}`;
    const parsed = parseAnalyticsManifestV1Json(source);
    expect(parsed.features[0].types[0].assembly).toHaveLength(256);
    expect(parsed.features[0].types[0].type).toHaveLength(256);

    const tooLong = source.replace(
      `"assembly":"${escaped}"`,
      `"assembly":"${escaped}\\u0061"`,
    );
    expect(() => parseAnalyticsManifestV1Json(tooLong)).toThrow(
      AnalyticsManifestValidationError,
    );
  });
});
