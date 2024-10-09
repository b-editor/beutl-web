import "server-only";
import { S3Client } from "@aws-sdk/client-s3";

export const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT as string,
  region: process.env.S3_REGION as string,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID as string,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY as string,
  },
});
