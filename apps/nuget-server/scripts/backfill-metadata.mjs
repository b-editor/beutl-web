import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--check')) throw new Error('Usage: backfill:metadata [--check]');
const require = createRequire(import.meta.url);
const { build } = createRequire(import.meta.resolve('wrangler/package.json'))('esbuild');
const root = fileURLToPath(new URL('../.wrangler/', import.meta.url));
await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, 'backfill-'));
try {
  const outfile = join(directory, 'metadata.cjs');
  await build({ entryPoints: [fileURLToPath(new URL('../src/backfill-metadata.ts', import.meta.url))],
    outfile, bundle: true, platform: 'node', format: 'cjs', external: ['@prisma/client', '@prisma/adapter-pg'] });
  await require(outfile).backfillMetadata(args.includes('--check'));
} finally { await rm(directory, { recursive: true, force: true }); }
