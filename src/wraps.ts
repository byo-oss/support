// Loads @aws-sdk/client-s3 with a dynamic import() on the first message, so
// importing this file never pulls the SDK in.
import {
  concatBytes,
  DEFAULT_INBOUND_MAX_BYTES,
  declaredLength,
  readCapped,
  secretsMatch,
} from "./inbound/raw-relay";
import type { SupportInboundSource } from "./options";

export { type WrapsMailerOptions, wrapsMailer } from "@byo-oss/mailer/wraps";

/** The part of an S3 client `wrapsInbound` uses, so tests pass a fake. */
export type WrapsInboundS3Client = {
  send(command: unknown): Promise<unknown>;
};

export type WrapsInboundOptions = {
  /** The `X-Wraps-Inbound-Key` secret Wraps sends with each event. */
  key: string;
  /** Bucket Wraps stores raw mail in. */
  bucket: string;
  region: string;
  /** An S3 client; one is created from `region` when omitted. */
  client?: WrapsInboundS3Client;
  /** Largest message accepted, in bytes. @default 26214400 */
  maxBytes?: number;
};

type S3Sdk = typeof import("@aws-sdk/client-s3");

// EventBridge caps an event at 256 KB; this leaves room for the envelope.
const MAX_EVENT_BYTES = 1_048_576;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `rawS3Key` from an EventBridge envelope (`{ detail: { … } }`) or a bare `detail`. */
function rawS3KeyOf(event: unknown): string | null {
  if (!isObject(event)) return null;
  const detail = isObject(event.detail) ? event.detail : event;
  const key = detail.rawS3Key;
  return typeof key === "string" && key.length > 0 ? key : null;
}

function isNoSuchKey(error: unknown): boolean {
  if (!isObject(error)) return false;
  // matched by name, not instanceof, so it works with any copy of the SDK
  return error.name === "NoSuchKey" || error.Code === "NoSuchKey";
}

/** The shapes an S3 `Body` comes in: a Node stream, a web stream, or bytes. */
type ByteSource = {
  getReader?: unknown;
  [Symbol.asyncIterator]?: unknown;
  transformToByteArray?: () => Promise<Uint8Array>;
  destroy?: () => void;
};

/** Reads an S3 `Body` (Node stream, web stream or SDK mixin), capped at `maxBytes`. */
async function readBody(
  body: unknown,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (body == null) return new Uint8Array(0);
  if (body instanceof Uint8Array) {
    return body.byteLength > maxBytes
      ? null
      : concatBytes([body], body.byteLength);
  }
  const source = body as ByteSource;
  if (typeof source.getReader === "function") {
    return readCapped(body as ReadableStream<Uint8Array>, maxBytes);
  }
  if (typeof source[Symbol.asyncIterator] === "function") {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > maxBytes) {
        source.destroy?.();
        return null;
      }
      chunks.push(chunk);
    }
    return concatBytes(chunks, size);
  }
  if (typeof source.transformToByteArray === "function") {
    const bytes = await source.transformToByteArray();
    return bytes.byteLength > maxBytes
      ? null
      : concatBytes([bytes], bytes.byteLength);
  }
  throw new Error("[@byo-oss/support] unreadable S3 object body");
}

/**
 * An inbound source for Wraps (SES → S3 → EventBridge `email.received`):
 * checks `X-Wraps-Inbound-Key` in constant time (401), reads `rawS3Key` from
 * the event and fetches the object. `NoSuchKey` → 404 (no retry); any other
 * S3 error → 502 (retry); over `maxBytes` → 413.
 *
 * Takes the whole EventBridge event (what an API destination posts) or just
 * its `detail`. A body that isn't JSON, or has no `rawS3Key`, answers 400.
 * Throws at setup when `key` is empty.
 *
 * The role needs `s3:GetObject` on the bucket, and `s3:ListBucket` too:
 * without it S3 reports a missing object as `AccessDenied`, which answers 502
 * and is retried, instead of `NoSuchKey`.
 *
 * ```ts
 * import { wrapsInbound } from "@byo-oss/support/wraps"
 * inbound: { source: wrapsInbound({ key, bucket, region: "us-east-1" }) }
 * ```
 */
export function wrapsInbound(
  options: WrapsInboundOptions,
): SupportInboundSource {
  const { key, bucket, region } = options;
  const maxBytes = options.maxBytes ?? DEFAULT_INBOUND_MAX_BYTES;
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("[@byo-oss/support] wrapsInbound needs a non-empty key");
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error(
      "[@byo-oss/support] wrapsInbound maxBytes must be an integer of at least 1",
    );
  }

  let sdk: Promise<S3Sdk> | undefined;
  let client: WrapsInboundS3Client | undefined = options.client;
  // Throws a clear error when the SDK isn't installed: the endpoint answers
  // 502 and the app sees why, instead of a bare 502 on every event.
  const loadSdk = () => {
    sdk ??= import("@aws-sdk/client-s3").catch((error: unknown) => {
      sdk = undefined;
      throw new Error(
        "[@byo-oss/support] wrapsInbound needs @aws-sdk/client-s3: npm install @aws-sdk/client-s3",
        { cause: error },
      );
    });
    return sdk;
  };

  return {
    async receive(request) {
      if (!secretsMatch(request.headers.get("x-wraps-inbound-key"), key)) {
        return { reject: 401 };
      }
      const declared = declaredLength(request.headers);
      if (declared !== null && declared > MAX_EVENT_BYTES) {
        return { reject: 413 };
      }
      const body = await readCapped(request.body, MAX_EVENT_BYTES);
      if (body === null) return { reject: 413 };
      let event: unknown;
      try {
        event = JSON.parse(new TextDecoder().decode(body));
      } catch {
        return { reject: 400 };
      }
      const objectKey = rawS3KeyOf(event);
      if (!objectKey) return { reject: 400 };

      // a real S3Client only accepts the SDK's own command objects
      const { GetObjectCommand, S3Client } = await loadSdk();
      client ??= new S3Client({ region });
      try {
        const object = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
        );
        const length = isObject(object) ? object.ContentLength : undefined;
        if (typeof length === "number" && length > maxBytes) {
          return { reject: 413 };
        }
        const raw = await readBody(
          isObject(object) ? object.Body : undefined,
          maxBytes,
        );
        if (raw === null) return { reject: 413 };
        return { raw };
      } catch (error) {
        return { reject: isNoSuchKey(error) ? 404 : 502 };
      }
    },
  };
}
