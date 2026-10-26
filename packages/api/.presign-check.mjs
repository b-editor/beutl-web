import { AwsClient } from "aws4fetch";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const env = Object.fromEntries(
  readFileSync("../../.env.production", "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^"|"$/gu, "")];
    }),
);
const client = new AwsClient({
  accessKeyId: env.BEUTL_S3_ACCESS_KEY_ID,
  secretAccessKey: env.BEUTL_S3_SECRET_ACCESS_KEY,
  region: env.BEUTL_S3_REGION,
  service: "s3",
});
const base = new URL(`${env.BEUTL_S3_ENDPOINT}/${env.BEUTL_S3_BUCKET}/presign-check-${randomUUID()}`);
const createRes = await fetch(await client.sign(`${base}?uploads`, { method: "POST" }));
const createXml = await createRes.text();
const uploadId = /<UploadId>([^<]+)<\/UploadId>/u.exec(createXml)?.[1];
console.log("create", createRes.status, Boolean(uploadId));
if (!uploadId) process.exit(1);

const partUrl = new URL(base);
partUrl.searchParams.set("partNumber", "1");
partUrl.searchParams.set("uploadId", uploadId);
partUrl.searchParams.set("X-Amz-Expires", "900");
const signed = await client.sign(partUrl.toString(), { method: "PUT", aws: { signQuery: true } });
const putRes = await fetch(signed.url, { method: "PUT", body: new Uint8Array(1024) });
console.log("presigned put", putRes.status, Boolean(putRes.headers.get("etag")));
await putRes.body?.cancel().catch(() => undefined);

const abortUrl = new URL(base);
abortUrl.searchParams.set("uploadId", uploadId);
const abortRes = await fetch(await client.sign(abortUrl.toString(), { method: "DELETE" }));
console.log("abort", abortRes.status);
await abortRes.body?.cancel().catch(() => undefined);
process.exit(putRes.ok ? 0 : 1);
