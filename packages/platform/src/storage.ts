import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

export type StorageConfig = {
  endpoint?: string;
  region: string;
  accessKey?: string;
  secretKey?: string;
};

export type ObjectStore = {
  ensureBucket(bucket: string): Promise<void>;
  put(bucket: string, key: string, body: Buffer, mime: string, metadata?: Record<string, string>): Promise<{ sha256: string; size: number }>;
  get(bucket: string, key: string): Promise<{ body: Buffer; mime: string | undefined; metadata: Record<string, string> }>;
  remove(bucket: string, key: string): Promise<void>;
  list(bucket: string, prefix: string): Promise<{ key: string; size: number; modifiedAt: string }[]>;
};

async function toBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** S3-compatible object storage (MinIO locally). */
export function createObjectStore(cfg: StorageConfig): ObjectStore {
  const client = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: true,
    credentials: cfg.accessKey && cfg.secretKey ? { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey } : undefined,
  });
  return {
    async ensureBucket(bucket) {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      }
    },
    async put(bucket, key, body, mime, metadata) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: mime, ...(metadata ? { Metadata: metadata } : {}) }));
      return { sha256: createHash("sha256").update(body).digest("hex"), size: body.length };
    },
    async get(bucket, key) {
      const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return { body: await toBuffer(out.Body as Readable), mime: out.ContentType, metadata: out.Metadata ?? {} };
    },
    async remove(bucket, key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async list(bucket, prefix) {
      const out: { key: string; size: number; modifiedAt: string }[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }));
        for (const o of page.Contents ?? []) if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0, modifiedAt: (o.LastModified ?? new Date()).toISOString() });
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token && out.length < 50_000);
      return out;
    },
  };
}
