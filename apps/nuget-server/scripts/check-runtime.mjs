import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run the built bundle, including its ZIP parser and WASM, in the same workerd
// runtime that Wrangler uses. Bundling alone cannot detect startup failures.
const requireWrangler = createRequire(import.meta.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = requireWrangler('miniflare');
const { build } = requireWrangler('esbuild');
const { experimental_readRawConfig } = requireWrangler('wrangler');
const { rawConfig } = experimental_readRawConfig({ config: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)) });
const secrets = rawConfig.secrets_store_secrets;
const buildDirectory = fileURLToPath(new URL('../.wrangler/build/', import.meta.url));
const wasmModules = (await readdir(buildDirectory)).filter(name => name.endsWith('.wasm'));
const runtime = new Miniflare(convertV4MiniflareOptions({
  modulesRoot: buildDirectory,
  modules: [
    { type: 'ESModule', path: join(buildDirectory, 'index.js') },
    ...wasmModules.map(name => ({ type: 'CompiledWasm', path: join(buildDirectory, name) })),
  ],
  compatibilityDate: '2025-04-04',
  compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public', 'enable_request_signal'],
  hyperdrives: { BEUTL_DATABASE_HYPERDRIVE: 'postgresql://unused:unused@127.0.0.1:1/unused' },
  r2Buckets: ['BEUTL_R2_BUCKET'],
  bindings: { NUGET_PUBLIC_ORIGIN: 'https://nuget.beditor.net' },
  secretsStoreSecrets: Object.fromEntries(secrets.map(({ binding, ...secret }) => [binding, secret])),
}));
try {
  for (const { binding } of secrets) {
    const api = (await runtime.getSecretsStoreSecretAPI(binding))();
    await api.create(`runtime-check-no-user-data-${binding}`);
  }
  const response = await runtime.dispatchFetch('https://nuget.beditor.net/v3/index.json');
  assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
  const index = await response.json();
  assert.equal(index.version, '3.0.0');
  assert.ok(index.resources.some(resource => resource['@type'] === 'PackagePublish/2.0.0'));
  const unauthenticated = await runtime.dispatchFetch('https://nuget.beditor.net/api/v2/package/', { method: 'PUT', body: 'invalid' });
  assert.equal(unauthenticated.status, 401);
  console.log('NuGet Worker Secrets Store bindings, service index and unauthenticated push passed.');
} finally {
  await runtime.dispose();
}

// The storage layer supplies fixed-length streams for R2. Check that the S3
// adapter also accepts them in workerd, whose native stream piping differs
// from Node's implementation.
const storageBundle = await build({
  stdin: {
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    contents: `
      import { createS3CompatibleBucket } from '@beutl/api/storage/s3-compatible-bucket';
      export default {
        async fetch() {
          const received = [];
          const bucket = createS3CompatibleBucket({
            endpoint: 'https://s3.example.test', bucket: 'test',
            accessKeyId: 'test', secretAccessKey: 'test',
            fetch: async (request) => {
              received.push(await request.text());
              return new Response(null, { headers: { etag: '"test"' } });
            },
          });
          const bytes = new TextEncoder().encode('NuGet stream');
          const stream = () => new ReadableStream({
            start(controller) { controller.enqueue(bytes); controller.close(); },
          }).pipeThrough(new FixedLengthStream(bytes.length));
          await bucket.put('package', stream(), { contentLength: bytes.length });
          await bucket.resumeMultipartUpload('package', 'test').uploadPart(1, stream(), { contentLength: bytes.length });
          let rejectedLengthMismatch = false;
          try { await bucket.put('invalid', stream(), { contentLength: bytes.length + 1 }); }
          catch { rejectedLengthMismatch = true; }
          return Response.json({ received, rejectedLengthMismatch });
        },
      };
    `,
  },
  bundle: true, write: false, platform: 'browser', format: 'esm',
});
const storageRuntime = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  script: storageBundle.outputFiles[0].text,
  compatibilityDate: '2025-04-04',
}));
try {
  const response = await storageRuntime.dispatchFetch('https://storage.example.test');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    received: ['NuGet stream', 'NuGet stream'], rejectedLengthMismatch: true,
  });
  console.log('Fixed-length S3 uploads, multipart uploads and length validation passed in workerd.');
} finally {
  await storageRuntime.dispose();
}

// Validate manifest decoding in workerd too: its UTF-16 decoder can accept
// lone surrogates even with fatal: true, unlike Node's implementation.
const { zipSync } = createRequire(new URL('../../../package.json', import.meta.url))('fflate');
const archiveBundle = await build({ stdin: { resolveDir: fileURLToPath(new URL('../../../packages/api/', import.meta.url)), contents: `
  import { blobReader, readNugetPackage, InvalidNugetPackageError } from './src/nuget/archive';
  export default { async fetch(request) {
    try { return Response.json(await readNugetPackage(blobReader(await request.blob()))); }
    catch (error) { if (error instanceof InvalidNugetPackageError) return new Response(error.message, { status: 400 }); throw error; }
  } };
` }, bundle: true, write: false, platform: 'node', format: 'esm', external: ['node:*'] });
const archiveRuntime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: archiveBundle.outputFiles[0].text,
  compatibilityDate: '2025-04-04', compatibilityFlags: ['nodejs_compat'] }));
const manifest = '<package><metadata><id>Sample.Library</id><version>1.0.0</version><authors>Owner</authors><description>日本語🚀</description></metadata></package>';
try {
  for (const encoding of ['utf-8', 'utf-16le', 'utf-16be']) {
    const xml = `<?xml version="1.0" encoding="${encoding === 'utf-8' ? encoding : 'utf-16'}"?>${manifest}`;
    const bytes = encoding === 'utf-8' ? Buffer.from(xml) : Buffer.from('\ufeff' + xml, 'utf16le');
    if (encoding === 'utf-16be') bytes.swap16();
    const response = await archiveRuntime.dispatchFetch('https://nuget.test', { method: 'POST', body: zipSync({ 'Library.nuspec': bytes }) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.metadata.description, '日本語🚀');
    assert.ok(result.nuspec.includes('encoding="utf-8"'));
    console.log(`workerd accepted ${encoding}`);
  }
  for (const [name, bytes] of [
    ['utf-8', Buffer.concat([Buffer.from(manifest.split('日本語🚀')[0]), Buffer.from([0xc3, 0x28]), Buffer.from(manifest.split('日本語🚀')[1])])],
    ['utf-16le', Buffer.from('\ufeff' + manifest.replace('日本語🚀', '\ud800'), 'utf16le')],
    ['utf-16be', Buffer.from('\ufeff' + manifest.replace('日本語🚀', '\udc00'), 'utf16le').swap16()],
    ['truncated utf-16', Buffer.from('\ufeff' + manifest, 'utf16le').subarray(0, -1)],
  ]) {
    const response = await archiveRuntime.dispatchFetch('https://nuget.test', { method: 'POST', body: zipSync({ 'Library.nuspec': bytes }) });
    assert.equal(response.status, 400, await response.text());
    console.log(`workerd rejected malformed ${name}`);
  }
} finally { await archiveRuntime.dispose(); }
