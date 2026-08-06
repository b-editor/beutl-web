// pnpm workspace では @prisma/client は .pnpm ストア内の実体へのシンボリックリンクになる。
// Prisma Client 生成物 (.prisma/client) は @prisma/client の default.d.ts が
// `.prisma/client/default` を相対参照するため、ストア内の @prisma/client と同じ
// node_modules 階層 (.pnpm/.../node_modules/.prisma/client) に生成する必要がある。
//
// このスクリプトは schema.prisma の generator output を実行時に動的解決し、
// prisma generate 後に元の内容へ戻す (git を汚さない)。
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const appRoot = resolve(import.meta.dirname, "..");

// @prisma/client の package.json の実体パスを解決 (シンボリックリンクを辿る)
// @prisma/client は apps/web の依存なので、apps/web からの require.resolve で実体を引く
const webPkg = resolve(appRoot, "apps", "web", "package.json");
const clientPkg = require.resolve("@prisma/client/package.json", {
  paths: [dirname(webPkg)],
});
const clientDir = dirname(clientPkg);
// @prisma/client の親 node_modules の .prisma/client が生成先
const prismaDir = join(clientDir, "..", "..", ".prisma", "client");

const schemaPath = join(appRoot, "apps", "web", "prisma", "schema.prisma");
const schema = await readFile(schemaPath, "utf8");

const output = relative(dirname(schemaPath), prismaDir).replace(/\\/g, "/");
const tmpSchema = schema.replace(
  /(generator client \{\s*provider = "prisma-client-js")(\s*)output\s*=\s*"[^"]*"/,
  `$1$2output = "${output}"`,
);

await writeFile(schemaPath, tmpSchema);
try {
  const prismaBin = join(dirname(webPkg), "node_modules", ".bin", "prisma");
  execSync(`"${prismaBin}" generate`, { cwd: dirname(webPkg), stdio: "inherit" });
} finally {
  await writeFile(schemaPath, schema);
}
console.log(`Prisma Client generated to ${prismaDir}`);
