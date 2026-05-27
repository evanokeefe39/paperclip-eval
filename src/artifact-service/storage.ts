import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";

const client = new S3Client({
  endpoint: process.env.S3_ENDPOINT || "http://minio:9000",
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY || "minioadmin",
    secretAccessKey: process.env.S3_SECRET_KEY || "minioadmin",
  },
  region: process.env.S3_REGION || "us-east-1",
  forcePathStyle: true,
});

/** Upload a blob to MinIO/S3. */
export async function putBlob(
  bucket: string,
  key: string,
  content: Buffer,
  mime: string,
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: content,
      ContentType: mime,
    }),
  );
}

/** Download a blob from MinIO/S3. Returns the full content as a Buffer. */
export async function getBlob(bucket: string, key: string): Promise<Buffer> {
  const resp = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );

  if (!resp.Body) {
    throw new Error(`Empty body returned for s3://${bucket}/${key}`);
  }

  // resp.Body is a Readable stream — collect into a Buffer.
  const chunks: Uint8Array[] = [];
  for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Health check — attempt HeadBucket on the "artifacts" bucket.
 * Returns true if MinIO is reachable and the bucket exists, false otherwise.
 */
export async function checkConnection(): Promise<boolean> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: "artifacts" }));
    return true;
  } catch {
    return false;
  }
}
