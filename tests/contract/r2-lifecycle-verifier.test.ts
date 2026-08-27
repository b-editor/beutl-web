import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const validator = fileURLToPath(new URL(
  "../../scripts/validate-r2-lifecycle-output.awk",
  import.meta.url,
));

function accepts(output: string): boolean {
  try {
    execFileSync("awk", ["-f", validator], { input: output });
    return true;
  } catch {
    return false;
  }
}

describe("R2 lifecycle release gate", () => {
  it("accepts the enabled seven-day multipart rule", () => {
    expect(accepts(`
name: abort-incomplete-multipart-uploads
enabled: Yes
prefix: (all prefixes)
action: Abort incomplete multipart uploads after 7 days
`)).toBe(true);
  });

  it("rejects a disabled rule", () => {
    expect(accepts(`
name: abort-incomplete-multipart-uploads
enabled: No
prefix: (all prefixes)
action: Abort incomplete multipart uploads after 7 days
`)).toBe(false);
  });

  it("rejects evidence split across different rules", () => {
    expect(accepts(`
name: abort-incomplete-multipart-uploads
enabled: Yes
prefix: (all prefixes)
action: Abort incomplete multipart uploads after 30 days

name: unrelated-seven-day-rule
enabled: Yes
prefix: (all prefixes)
action: Expire objects after 7 days
`)).toBe(false);
  });
});
