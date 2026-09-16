import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const repo = resolve(import.meta.dirname, "../..");
const roots: string[] = [];
const schema = `generator client {
  provider = "prisma-client-js"
  output   = "../node_modules/.prisma/client"
}

datasource db {
  provider = "cockroachdb"
}

model Example {
  id String @id
}
`;

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "beutl prisma-generate ")));
  roots.push(root);
  const web = join(root, "apps/web");
  const schemaDir = join(web, "prisma");
  const store = join(root, "node_modules/.pnpm/client-fixture/node_modules");
  const client = join(store, "@prisma/client");
  const prisma = join(web, "node_modules/prisma");
  await Promise.all([schemaDir, client, prisma, join(web, "node_modules/@prisma"),
    join(web, "node_modules/.bin"), join(root, "scripts"), join(root, "reports")]
    .map((path) => mkdir(path, { recursive: true })));
  await writeFile(join(web, "package.json"), JSON.stringify({ name: "fixture-web" }));
  await writeFile(join(client, "package.json"), JSON.stringify({ name: "@prisma/client" }));
  await symlink(client, join(web, "node_modules/@prisma/client"), "junction");
  await writeFile(join(prisma, "package.json"), JSON.stringify({
    name: "prisma", main: "types.cjs", bin: { prisma: "index.cjs" },
    exports: { ".": "./types.cjs", "./package.json": "./package.json" },
  }));
  await writeFile(join(schemaDir, "schema.prisma"), schema);
  await writeFile(join(root, "expected.prisma"), schema);
  const cli = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.env.FIXTURE_ROOT;
const canonical = path.join(root, 'apps/web/prisma/schema.prisma');
assert.equal(fs.readFileSync(canonical, 'utf8'), fs.readFileSync(path.join(root, 'expected.prisma'), 'utf8'),
  'The checked-in schema must not change while Prisma is running');
const index = process.argv.indexOf('--schema');
assert.ok(index >= 0, 'Generation must use an isolated schema');
const input = path.resolve(process.argv[index + 1]);
assert.notEqual(input, canonical);
const contents = fs.readFileSync(input, 'utf8');
assert.match(contents, /datasource db/);
assert.match(contents, /provider = "cockroachdb"/);
const output = JSON.parse(contents.match(/output\\s*=\\s*("[^"\\n]*")/)[1]);
assert.equal(path.resolve(path.dirname(input), output), path.join(root, 'node_modules/.pnpm/client-fixture/node_modules/.prisma/client'));
fs.writeFileSync(path.join(root, 'reports', process.pid + '.json'), JSON.stringify({ input }));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
if (process.env.FAIL_PRISMA === '1') process.exit(23);
`;
  await writeFile(join(prisma, "index.cjs"), cli);
  await writeFile(join(web, "node_modules/.bin/prisma"), cli);
  await chmod(join(web, "node_modules/.bin/prisma"), 0o755);
  await copyFile(join(repo, "scripts/prisma-generate.mjs"), join(root, "scripts/prisma-generate.mjs"));
  return {
    root,
    generate: (fail = false) => run(process.execPath, [join(root, "scripts/prisma-generate.mjs")], {
      cwd: web,
      env: { ...process.env, FIXTURE_ROOT: root, FAIL_PRISMA: fail ? "1" : "0" },
    }),
    reports: async () => Promise.all((await readdir(join(root, "reports")))
      .map(async (file) => JSON.parse(await readFile(join(root, "reports", file), "utf8")) as { input: string })),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Prisma generation during workspace install", () => {
  it("has a single lifecycle owner for the shared generated client", async () => {
    const owners: string[] = [];
    const packages = [join(repo, "package.json")];
    for (const group of ["apps", "packages"]) {
      for (const name of await readdir(join(repo, group))) packages.push(join(repo, group, name, "package.json"));
    }
    for (const file of packages) {
      const text = await readFile(file, "utf8").catch(() => null);
      if (text && JSON.parse(text).scripts?.postinstall?.includes("prisma-generate")) owners.push(dirname(file));
    }
    expect(owners).toEqual([repo]);
  });

  it("never rewrites the source schema and gives concurrent invocations separate input files", async () => {
    const test = await fixture();
    const results = await Promise.allSettled([test.generate(), test.generate()]);
    for (const result of results) expect(result.status, result.status === "rejected" ? String(result.reason) : "").toBe("fulfilled");
    expect(await readFile(join(test.root, "apps/web/prisma/schema.prisma"), "utf8")).toBe(schema);
    const reports = await test.reports();
    expect(reports).toHaveLength(2);
    expect(new Set(reports.map((x) => x.input)).size).toBe(2);
    for (const { input } of reports) await expect(readFile(input)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans up its input and preserves the schema when Prisma exits unsuccessfully", async () => {
    const test = await fixture();
    await expect(test.generate(true)).rejects.toMatchObject({ code: 1 });
    const reports = await test.reports();
    expect(reports).toHaveLength(1);
    await expect(readFile(reports[0].input)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(test.root, "apps/web/prisma/schema.prisma"), "utf8")).toBe(schema);
  });
});
