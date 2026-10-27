import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = path.join(root, 'apps/web/public/preview-client');
await copyFile(path.join(root, 'packages/ui/src/styles/theme.css'), path.join(client, 'theme.css'));
await copyFile(path.join(root, 'apps/web/public/img/logo_dark.svg'), path.join(client, 'logo.svg'));
if (process.argv[2]) {
  const target = path.resolve(process.argv[2], 'src/Beutl/PreviewStreaming/Client');
  await mkdir(target, { recursive: true });
  for (const file of await readdir(client)) await copyFile(path.join(client, file), path.join(target, file));
}
