// pnpm workspace では @prisma/client は .pnpm ストア内の実体へのシンボリックリンクになる。
// Prisma Client 生成物 (.prisma/client) は @prisma/client の default.d.ts が
// `.prisma/client/default` を相対参照するため、ストア内の @prisma/client と同じ
// node_modules 階層 (.pnpm/.../node_modules/.prisma/client) に生成する必要がある。
//
// 共有クライアントはワークスペース直下の postinstall で一度だけ生成する。
// generator output は一時スキーマ内で解決し、元の schema.prisma は書き換えない。
// アプリごとの postinstall で元ファイルを書き換えると、同時実行時に空のスキーマを
// 読み取ったり、生成先のクライアントを互いに上書きしたりする。
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";

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
let replaced = false;
const tmpSchema = schema.replace(
  /(generator client \{\s*provider = "prisma-client-js")(\s*)output\s*=\s*"[^"]*"/,
  (_, generator, whitespace) => {
    replaced = true;
    return `${generator}${whitespace}output = ${JSON.stringify(output)}`;
  },
);
if (!replaced) throw new Error("Could not locate the Prisma Client output in schema.prisma");

// Keep the schema directory unchanged so Prisma's generated relative paths stay valid.
const tmpSchemaPath = join(dirname(schemaPath), `.prisma-generate-${randomUUID()}.prisma`);
await writeFile(tmpSchemaPath, tmpSchema, { flag: "wx" });
try {
  const prismaPkg = require.resolve("prisma/package.json", { paths: [dirname(webPkg)] });
  const prismaMetadata = JSON.parse(await readFile(prismaPkg, "utf8"));
  const prismaCli = resolve(dirname(prismaPkg), prismaMetadata.bin.prisma);
  execFileSync(process.execPath, [prismaCli, "generate", "--schema", tmpSchemaPath], {
    cwd: dirname(webPkg),
    stdio: "inherit",
  });
} finally {
  await rm(tmpSchemaPath, { force: true });
}
console.log(`Prisma Client generated to ${prismaDir}`);
