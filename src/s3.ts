// Loads @aws-sdk/client-s3 with a dynamic import() on first use (a real
// S3Client only accepts the SDK's own command objects, so the command classes
// come from it even when a client is passed), so importing this file never
// pulls the SDK in.
import type { SupportStorage, SupportStoredObject } from "./options";

/** The part of an S3 client `s3Storage` uses, so tests pass a fake. */
export type S3StorageClient = {
  send(command: unknown): Promise<unknown>;
};

export type S3StorageOptions = {
  bucket: string;
  region: string;
  /** For R2, MinIO and other S3-compatible stores. */
  endpoint?: string;
  /** Path-style URLs (MinIO). @default false */
  forcePathStyle?: boolean;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  /** An S3 client; one is created from the options above when omitted. */
  client?: S3StorageClient;
};

type S3Sdk = typeof import("@aws-sdk/client-s3");

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** A missing object, matched by name or status so any copy of the SDK works. */
function isNotFound(error: unknown): boolean {
  if (!isObject(error)) return false;
  if (error.name === "NoSuchKey" || error.name === "NotFound") return true;
  if (error.Code === "NoSuchKey") return true;
  const metadata = isObject(error.$metadata) ? error.$metadata : undefined;
  return metadata?.httpStatusCode === 404;
}

/** A one-chunk stream over `bytes`. */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** The shapes an S3 `Body` comes in: an SDK stream mixin, a web stream, a Node stream or bytes. */
type ByteSource = {
  transformToWebStream?: () => ReadableStream<Uint8Array>;
  getReader?: unknown;
  [Symbol.asyncIterator]?: unknown;
};

/** An S3 `Body` as a web `ReadableStream`. */
function toWebStream(body: unknown): ReadableStream<Uint8Array> {
  if (body == null) return streamOf(new Uint8Array(0));
  if (body instanceof Uint8Array) return streamOf(body);
  const source = body as ByteSource;
  if (typeof source.transformToWebStream === "function") {
    return source.transformToWebStream();
  }
  if (typeof source.getReader === "function") {
    return body as ReadableStream<Uint8Array>;
  }
  if (typeof source[Symbol.asyncIterator] === "function") {
    const iterator = (body as AsyncIterable<Uint8Array>)[
      Symbol.asyncIterator
    ]();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(new Uint8Array(value));
      },
      async cancel() {
        await iterator.return?.();
      },
    });
  }
  throw new Error("[@byo-oss/support] unreadable S3 object body");
}

/**
 * `SupportStorage` on S3 or any S3-compatible store (R2, MinIO). Every method
 * throws on an S3 error; `get` resolves null for a missing key.
 * `deletePrefix` lists the prefix 1000 keys at a time (`ListObjectsV2`) and
 * deletes each page with one `DeleteObjects`; any per-key error throws.
 *
 * Needs `@aws-sdk/client-s3` installed (an optional peer dependency); it is
 * loaded on first use. The role needs `s3:PutObject`, `s3:GetObject`,
 * `s3:DeleteObject` and `s3:ListBucket` on the bucket.
 *
 * ```ts
 * import { s3Storage } from "@byo-oss/support/s3"
 * attachments: { storage: s3Storage({ bucket: "acme-support", region: "us-east-1" }) }
 * ```
 */
export function s3Storage(options: S3StorageOptions): SupportStorage {
  const { bucket, region } = options;
  if (typeof bucket !== "string" || bucket.length === 0) {
    throw new Error("[@byo-oss/support] s3Storage needs a bucket");
  }

  let sdk: Promise<S3Sdk> | undefined;
  let client: S3StorageClient | undefined = options.client;
  const loadSdk = () => {
    sdk ??= import("@aws-sdk/client-s3").catch((error: unknown) => {
      sdk = undefined;
      throw new Error(
        "[@byo-oss/support] s3Storage needs @aws-sdk/client-s3: npm install @aws-sdk/client-s3",
        { cause: error },
      );
    });
    return sdk;
  };
  /** The SDK's command classes and the client to send them with. */
  const connect = async () => {
    const commands = await loadSdk();
    client ??= new commands.S3Client({
      region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(options.forcePathStyle ? { forcePathStyle: true } : {}),
      ...(options.credentials ? { credentials: options.credentials } : {}),
    });
    return { commands, client };
  };

  return {
    async put({ key, body, contentType }) {
      const { commands, client } = await connect();
      await client.send(
        new commands.PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ContentLength: body.byteLength,
        }),
      );
    },

    async get(key): Promise<SupportStoredObject | null> {
      const { commands, client } = await connect();
      let object: unknown;
      try {
        object = await client.send(
          new commands.GetObjectCommand({ Bucket: bucket, Key: key }),
        );
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
      const output = isObject(object) ? object : {};
      const length = output.ContentLength;
      const contentType = output.ContentType;
      const body = output.Body;
      return {
        body: toWebStream(body),
        contentType:
          typeof contentType === "string" && contentType
            ? contentType
            : "application/octet-stream",
        size:
          typeof length === "number"
            ? length
            : body instanceof Uint8Array
              ? body.byteLength
              : 0,
      };
    },

    async delete(key) {
      const { commands, client } = await connect();
      try {
        await client.send(
          new commands.DeleteObjectCommand({ Bucket: bucket, Key: key }),
        );
      } catch (error) {
        // S3 itself answers 204 for a missing key; some compatible stores don't
        if (!isNotFound(error)) throw error;
      }
    },

    async deletePrefix(prefix) {
      if (!prefix) {
        throw new Error("[@byo-oss/support] deletePrefix needs a prefix");
      }
      const { commands, client } = await connect();
      let token: string | undefined;
      do {
        const page = await client.send(
          new commands.ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            MaxKeys: 1000,
            ...(token ? { ContinuationToken: token } : {}),
          }),
        );
        const listed = isObject(page) ? page : {};
        const contents = Array.isArray(listed.Contents) ? listed.Contents : [];
        const keys = contents
          .map((item) => (isObject(item) ? item.Key : undefined))
          .filter((key): key is string => typeof key === "string");
        if (keys.length > 0) {
          const result = await client.send(
            new commands.DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
            }),
          );
          const errors =
            isObject(result) && Array.isArray(result.Errors)
              ? result.Errors
              : [];
          if (errors.length > 0) {
            const first = isObject(errors[0]) ? errors[0] : {};
            throw new Error(
              `[@byo-oss/support] s3Storage could not delete ${errors.length} object(s) under ${prefix}: ${String(first.Code ?? "")} ${String(first.Message ?? "")}`.trim(),
            );
          }
        }
        token =
          listed.IsTruncated === true &&
          typeof listed.NextContinuationToken === "string"
            ? listed.NextContinuationToken
            : undefined;
      } while (token);
    },
  };
}
