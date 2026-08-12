# Marketplace analytics feature manifest v1

An extension release may contain an optional file at the exact archive path
`beutl/analytics-features.v1.json`. It lets a verified Marketplace release use
static feature IDs in Beutl product analytics. The manifest is not a runtime
analytics API and cannot register arbitrary events, attributes, or types.

The accepted JSON shape is:

```json
{
  "schemaVersion": 1,
  "features": [
    {
      "kind": "effect",
      "key": "color-grade",
      "types": [
        {
          "assembly": "Example.Extension",
          "type": "Example.Extension.ColorGrade"
        }
      ]
    }
  ]
}
```

All object fields are required. Unknown fields are rejected. A manifest must
contain from one through 128 features, and each feature must contain from one
through eight type mappings. The uncompressed manifest must not exceed 64 KiB.

`kind` must match `[a-z][a-z0-9-]{0,31}` and `key` must match
`[a-z][a-z0-9-]{0,63}`. `assembly` must be a simple assembly name from 1
through 256 characters, with dot-separated segments matching
`[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*`. `type` must be a
dot-separated public type name from 1 through 256 characters matching
`[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*`. Length limits
are evaluated after JSON escape decoding.

Each `kind`/`key` pair must be unique. An exact `assembly`/`type` mapping may
appear in only one feature. Schema versions other than `1`, duplicate manifest
entries, duplicate JSON member names at any nesting level, malformed JSON,
non-UTF-8 content, and corrupt package archives are rejected at upload time.

Marketplace keeps the existing 1 GiB release quota. It locates the ZIP end and
central directory with bounded random-access reads and decompresses only the
exact manifest entry. Large legacy/native/resource packages, high-compression
non-manifest resources, ZIP64 archives, and archives with many entries remain
compatible. Actual manifest output is stopped at 64 KiB; reported ZIP sizes
are not trusted for that limit. Non-canonical target path variants, duplicate
manifest paths, invalid UTF-8 names, encryption, unsupported target
compression, inconsistent local/central metadata, and corrupt descriptors
fail closed.

For a `.nupkg` upload, Marketplace computes the SHA-256 of the validated
uncompressed manifest bytes and persists it on the release alongside the
release file. The release file already has its own SHA-256. Release responses
expose `fileId`, nullable `packageSha256`, and nullable
`approvedAnalyticsManifestSha256` from the same selected artifact. File
responses expose `sha256` and the nullable approved manifest digest. Approval
is `null` for legacy packages, packages without a manifest, and any digest
mismatch. A client must require the exact Marketplace provenance, package
SHA-256, and approved manifest SHA-256 before using exact feature IDs;
otherwise it must use a generic category.
