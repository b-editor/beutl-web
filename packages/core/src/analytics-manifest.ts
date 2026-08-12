export const analyticsManifestV1Path = "beutl/analytics-features.v1.json";
export const analyticsManifestV1MaxBytes = 64 * 1024;
export const analyticsManifestV1MaxFeatures = 128;
export const analyticsManifestV1MaxTypesPerFeature = 8;
export const analyticsManifestV1MaxTypeIdentifierCharacters = 256;

const kindPattern = /^[a-z][a-z0-9-]{0,31}$/;
const keyPattern = /^[a-z][a-z0-9-]{0,63}$/;
const assemblyPattern = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/;
const typePattern = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

export type AnalyticsManifestTypeV1 = Readonly<{
  assembly: string;
  type: string;
}>;

export type AnalyticsManifestFeatureV1 = Readonly<{
  kind: string;
  key: string;
  types: readonly AnalyticsManifestTypeV1[];
}>;

export type AnalyticsManifestV1 = Readonly<{
  schemaVersion: 1;
  features: readonly AnalyticsManifestFeatureV1[];
}>;

export class AnalyticsManifestValidationError extends Error {
  constructor() {
    super("The analytics feature manifest is invalid.");
    this.name = "AnalyticsManifestValidationError";
  }
}

function invalid(): never {
  throw new AnalyticsManifestValidationError();
}

const maxJsonDepth = 32;
const maxJsonValues = 8192;

class UniqueMemberJsonParser {
  private index = 0;
  private valueCount = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.source.length) {
      return invalid();
    }

    return value;
  }

  private parseValue(depth: number): unknown {
    if (depth > maxJsonDepth || ++this.valueCount > maxJsonValues) {
      return invalid();
    }

    const token = this.source[this.index];
    if (token === "{") {
      return this.parseObject(depth);
    }
    if (token === "[") {
      return this.parseArray(depth);
    }
    if (token === '"') {
      return this.parseString();
    }
    if (token === "t" && this.consumeLiteral("true")) {
      return true;
    }
    if (token === "f" && this.consumeLiteral("false")) {
      return false;
    }
    if (token === "n" && this.consumeLiteral("null")) {
      return null;
    }

    return this.parseNumber();
  }

  private parseObject(depth: number): Record<string, unknown> {
    this.index++;
    this.skipWhitespace();
    const result = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    if (this.source[this.index] === "}") {
      this.index++;
      return result;
    }

    while (this.index < this.source.length) {
      if (this.source[this.index] !== '"') {
        return invalid();
      }
      const key = this.parseString();
      if (keys.has(key)) {
        return invalid();
      }
      keys.add(key);

      this.skipWhitespace();
      if (this.source[this.index++] !== ":") {
        return invalid();
      }
      this.skipWhitespace();
      result[key] = this.parseValue(depth + 1);
      this.skipWhitespace();

      const separator = this.source[this.index++];
      if (separator === "}") {
        return result;
      }
      if (separator !== ",") {
        return invalid();
      }
      this.skipWhitespace();
    }

    return invalid();
  }

  private parseArray(depth: number): unknown[] {
    this.index++;
    this.skipWhitespace();
    const result: unknown[] = [];
    if (this.source[this.index] === "]") {
      this.index++;
      return result;
    }

    while (this.index < this.source.length) {
      result.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const separator = this.source[this.index++];
      if (separator === "]") {
        return result;
      }
      if (separator !== ",") {
        return invalid();
      }
      this.skipWhitespace();
    }

    return invalid();
  }

  private parseString(): string {
    const start = this.index++;
    while (this.index < this.source.length) {
      const character = this.source.charCodeAt(this.index++);
      if (character === 0x22) {
        try {
          const value: unknown = JSON.parse(this.source.slice(start, this.index));
          return typeof value === "string" ? value : invalid();
        } catch {
          return invalid();
        }
      }
      if (character < 0x20) {
        return invalid();
      }
      if (character === 0x5c) {
        const escape = this.source[this.index++];
        if (escape === "u") {
          const codePoint = this.source.slice(this.index, this.index + 4);
          if (!/^[0-9A-Fa-f]{4}$/.test(codePoint)) {
            return invalid();
          }
          this.index += 4;
        } else if (!escape || !'"\\/bfnrt'.includes(escape)) {
          return invalid();
        }
      }
    }

    return invalid();
  }

  private parseNumber(): number {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      this.source.slice(this.index),
    );
    if (!match) {
      return invalid();
    }

    this.index += match[0].length;
    return Number(match[0]);
  }

  private consumeLiteral(literal: string): boolean {
    if (!this.source.startsWith(literal, this.index)) {
      return false;
    }

    this.index += literal.length;
    return true;
  }

  private skipWhitespace(): void {
    while (
      this.source[this.index] === " " ||
      this.source[this.index] === "\n" ||
      this.source[this.index] === "\r" ||
      this.source[this.index] === "\t"
    ) {
      this.index++;
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid();
  }

  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key) => !expected.includes(key))
  ) {
    invalid();
  }
}

function requireString(
  value: unknown,
  pattern: RegExp,
  maximumCharacters?: number,
): string {
  if (
    typeof value !== "string" ||
    !pattern.test(value) ||
    (maximumCharacters !== undefined && value.length > maximumCharacters)
  ) {
    return invalid();
  }

  return value;
}

/**
 * Validates the static v1 Marketplace analytics manifest.
 *
 * The contract intentionally contains only trusted, static feature names and
 * exact assembly/type mappings. It has no extension-supplied display text,
 * runtime registration data, or arbitrary metadata.
 */
export function parseAnalyticsManifestV1(input: unknown): AnalyticsManifestV1 {
  const root = asRecord(input);
  requireExactKeys(root, ["schemaVersion", "features"]);
  if (root.schemaVersion !== 1 || !Array.isArray(root.features)) {
    return invalid();
  }
  if (
    root.features.length === 0 ||
    root.features.length > analyticsManifestV1MaxFeatures
  ) {
    return invalid();
  }

  const featureIds = new Set<string>();
  const assignedTypes = new Set<string>();
  const features = root.features.map((candidate) => {
    const feature = asRecord(candidate);
    requireExactKeys(feature, ["kind", "key", "types"]);

    const kind = requireString(feature.kind, kindPattern);
    const key = requireString(feature.key, keyPattern);
    const featureId = `${kind}/${key}`;
    if (featureIds.has(featureId) || !Array.isArray(feature.types)) {
      return invalid();
    }
    featureIds.add(featureId);

    if (
      feature.types.length === 0 ||
      feature.types.length > analyticsManifestV1MaxTypesPerFeature
    ) {
      return invalid();
    }

    const types = feature.types.map((candidateType) => {
      const type = asRecord(candidateType);
      requireExactKeys(type, ["assembly", "type"]);
      const assembly = requireString(
        type.assembly,
        assemblyPattern,
        analyticsManifestV1MaxTypeIdentifierCharacters,
      );
      const typeName = requireString(
        type.type,
        typePattern,
        analyticsManifestV1MaxTypeIdentifierCharacters,
      );
      const typeId = `${assembly}\u0000${typeName}`;
      if (assignedTypes.has(typeId)) {
        return invalid();
      }
      assignedTypes.add(typeId);
      return { assembly, type: typeName };
    });

    return { kind, key, types };
  });

  return { schemaVersion: 1, features };
}

/**
 * Parses a v1 manifest without permitting duplicate JSON object members.
 * Duplicate names are rejected at every nesting level, including names that
 * become equal only after JSON escape decoding.
 */
export function parseAnalyticsManifestV1Json(source: string): AnalyticsManifestV1 {
  return parseAnalyticsManifestV1(new UniqueMemberJsonParser(source).parse());
}
