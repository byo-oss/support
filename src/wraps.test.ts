import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { NoSuchKey } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rawRelay } from "./inbound/raw-relay";
import { testSupportInboundSource } from "./testing/inbound";
import { type WrapsInboundS3Client, wrapsInbound, wrapsMailer } from "./wraps";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const SECRET = "relay-secret-0123456789";
const KEY = "wraps-inbound-key-abcdef";
const BUCKET = "inbound-mail";
const URL_ = "https://app.example.com/api/auth/support/inbound";

const RAW = new TextEncoder().encode(
  [
    "From: Alice <alice@example.com>",
    "To: support@help.example.com",
    "Subject: Card declined",
    "Message-ID: <a1@example.com>",
    "",
    "My card was declined.",
    "",
  ].join("\r\n"),
);

function relayRequest(
  init: { auth?: string | null; body?: BodyInit | null } = {},
): Request {
  const headers = new Headers({ "content-type": "message/rfc822" });
  const auth = init.auth === undefined ? `Bearer ${SECRET}` : init.auth;
  if (auth !== null) headers.set("authorization", auth);
  return new Request(URL_, {
    method: "POST",
    headers,
    body: init.body === undefined ? RAW : init.body,
  });
}

function erroringStream(): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(RAW.slice(0, 10));
      } else {
        controller.error(new Error("connection reset"));
      }
    },
  });
}

const envelope = (rawS3Key: string) => ({
  version: "0",
  id: "6a7e8feb-b491-4cf7-a9f1-bf3703467718",
  "detail-type": "email.received",
  source: "wraps.inbound",
  time: "2026-10-20T12:00:00Z",
  region: "us-east-1",
  resources: [],
  detail: {
    emailId: "e1",
    from: { address: "alice@example.com" },
    subject: "Card declined",
    rawS3Key,
  },
});

function wrapsRequest(
  init: { key?: string | null; body?: unknown; rawBody?: string } = {},
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  const key = init.key === undefined ? KEY : init.key;
  if (key !== null) headers.set("x-wraps-inbound-key", key);
  const body =
    init.rawBody ?? JSON.stringify(init.body ?? envelope("raw/msg-1"));
  return new Request(URL_, { method: "POST", headers, body });
}

type FakeBody = "node" | "web" | "bytes" | "mixin";

/** A fake S3 that serves `objects`, the way the SDK shapes `GetObject`. */
function fakeS3(
  objects: Record<string, Uint8Array>,
  body: FakeBody = "node",
): WrapsInboundS3Client & { calls: { Bucket: string; Key: string }[] } {
  const calls: { Bucket: string; Key: string }[] = [];
  return {
    calls,
    async send(command) {
      const input = (command as { input: { Bucket: string; Key: string } })
        .input;
      calls.push(input);
      const bytes = objects[input.Key];
      if (!bytes) {
        throw new NoSuchKey({
          message: "The specified key does not exist.",
          $metadata: { httpStatusCode: 404 },
        });
      }
      const copy = bytes.slice();
      const Body =
        body === "node"
          ? Readable.from([copy.subarray(0, 7), copy.subarray(7)])
          : body === "web"
            ? new Blob([copy]).stream()
            : body === "bytes"
              ? copy
              : { transformToByteArray: async () => copy };
      return { Body, ContentLength: copy.byteLength };
    },
  };
}

const failingS3: WrapsInboundS3Client = {
  async send() {
    throw Object.assign(new Error("Service Unavailable"), {
      name: "ServiceUnavailable",
      $metadata: { httpStatusCode: 503 },
    });
  },
};

const wrapsSource = (client: WrapsInboundS3Client, maxBytes?: number) =>
  wrapsInbound({
    key: KEY,
    bucket: BUCKET,
    region: "us-east-1",
    client,
    maxBytes,
  });

afterEach(() => {
  vi.mocked(timingSafeEqual).mockClear();
});

describe("rawRelay", () => {
  testSupportInboundSource(() => rawRelay({ secret: SECRET }), {
    // rawRelay has no backend of its own; what fails is the relay's body stream
    failing: () => {
      const source = rawRelay({ secret: SECRET });
      return {
        receive: (request) =>
          source.receive(
            new Request(request.url, {
              method: "POST",
              headers: request.headers,
              body: erroringStream(),
              duplex: "half",
            } as RequestInit),
          ),
      };
    },
    fixtures: {
      accepted: () => relayRequest(),
      raw: RAW,
      unauthenticated: () => relayRequest({ auth: "Bearer wrong-secret" }),
    },
  });

  it("answers 401 for a wrong, missing or malformed secret", async () => {
    const source = rawRelay({ secret: SECRET });
    for (const auth of [
      "Bearer wrong",
      null,
      "",
      SECRET,
      `Basic ${SECRET}`,
      "Bearer ",
      `Bearer ${SECRET}x`,
      `Bearer ${SECRET.slice(0, -1)}`,
    ]) {
      expect(await source.receive(relayRequest({ auth }))).toEqual({
        reject: 401,
      });
    }
  });

  it("accepts the bearer scheme in any case", async () => {
    const source = rawRelay({ secret: SECRET });
    const result = await source.receive(
      relayRequest({ auth: `bearer ${SECRET}` }),
    );
    expect("raw" in result).toBe(true);
  });

  it("compares in constant time, on equal-length buffers even when lengths differ", async () => {
    const source = rawRelay({ secret: "s" });
    const spy = vi.mocked(timingSafeEqual);
    const long = "x".repeat(500);
    expect(
      await source.receive(relayRequest({ auth: `Bearer ${long}` })),
    ).toEqual({ reject: 401 });
    expect(spy).toHaveBeenCalledTimes(1);
    const [a, b] = spy.mock.calls[0] as [Uint8Array, Uint8Array];
    expect(a.byteLength).toBe(b.byteLength);

    const ok = await source.receive(relayRequest({ auth: "Bearer s" }));
    expect("raw" in ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("answers 413 past maxBytes, by Content-Length or by bytes read", async () => {
    const source = rawRelay({ secret: SECRET, maxBytes: RAW.byteLength - 1 });
    expect(await source.receive(relayRequest())).toEqual({ reject: 413 });

    // no Content-Length: a stream, cut off once past the cap
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(16));
      },
    });
    const request = new Request(URL_, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
      body: endless,
      duplex: "half",
    } as RequestInit);
    expect(request.headers.get("content-length")).toBeNull();
    expect(
      await rawRelay({ secret: SECRET, maxBytes: 100 }).receive(request),
    ).toEqual({ reject: 413 });
    expect(pulled).toBeLessThan(20);

    const exact = rawRelay({ secret: SECRET, maxBytes: RAW.byteLength });
    expect("raw" in (await exact.receive(relayRequest()))).toBe(true);
  });

  it("checks the secret before reading the body", async () => {
    const source = rawRelay({ secret: SECRET, maxBytes: 1 });
    expect(await source.receive(relayRequest({ auth: "Bearer no" }))).toEqual({
      reject: 401,
    });
  });

  it("answers 400 for an empty body", async () => {
    const source = rawRelay({ secret: SECRET });
    expect(await source.receive(relayRequest({ body: null }))).toEqual({
      reject: 400,
    });
  });

  it("throws at setup for an empty secret or a bad maxBytes", () => {
    expect(() => rawRelay({ secret: "" })).toThrow(/non-empty secret/);
    expect(() => rawRelay({ secret: SECRET, maxBytes: 0 })).toThrow(/maxBytes/);
  });
});

describe("wrapsInbound", () => {
  testSupportInboundSource(() => wrapsSource(fakeS3({ "raw/msg-1": RAW })), {
    failing: () => wrapsSource(failingS3),
    fixtures: {
      accepted: () => wrapsRequest(),
      raw: RAW,
      unauthenticated: () => wrapsRequest({ key: "wrong-key" }),
    },
  });

  it("answers 401 for a wrong or missing key, without touching S3", async () => {
    const s3 = fakeS3({ "raw/msg-1": RAW });
    const source = wrapsSource(s3);
    for (const key of ["wrong", null, "", `${KEY}x`, KEY.slice(1)]) {
      expect(await source.receive(wrapsRequest({ key }))).toEqual({
        reject: 401,
      });
    }
    expect(s3.calls).toEqual([]);
  });

  it("compares the key in constant time", async () => {
    const source = wrapsSource(fakeS3({ "raw/msg-1": RAW }));
    const spy = vi.mocked(timingSafeEqual);
    await source.receive(wrapsRequest({ key: "k" }));
    expect(spy).toHaveBeenCalledTimes(1);
    const [a, b] = spy.mock.calls[0] as [Uint8Array, Uint8Array];
    expect(a.byteLength).toBe(b.byteLength);
  });

  it("accepts the EventBridge envelope and a bare detail", async () => {
    const s3 = fakeS3({ "raw/msg-1": RAW, "raw/msg-2": RAW });
    const source = wrapsSource(s3);
    const fromEnvelope = await source.receive(wrapsRequest());
    const fromDetail = await source.receive(
      wrapsRequest({ body: envelope("raw/msg-2").detail }),
    );
    for (const result of [fromEnvelope, fromDetail]) {
      expect("raw" in result).toBe(true);
      if ("raw" in result)
        expect(Array.from(result.raw)).toEqual(Array.from(RAW));
    }
    expect(s3.calls).toEqual([
      { Bucket: BUCKET, Key: "raw/msg-1" },
      { Bucket: BUCKET, Key: "raw/msg-2" },
    ]);
  });

  it("reads every S3 body shape into a plain Uint8Array", async () => {
    for (const shape of ["node", "web", "bytes", "mixin"] as const) {
      const result = await wrapsSource(
        fakeS3({ "raw/msg-1": RAW }, shape),
      ).receive(wrapsRequest());
      expect("raw" in result).toBe(true);
      if (!("raw" in result)) continue;
      expect(result.raw.constructor).toBe(Uint8Array);
      expect(Array.from(result.raw)).toEqual(Array.from(RAW));
    }
  });

  it("answers 400 for bad JSON or an event without rawS3Key", async () => {
    const s3 = fakeS3({ "raw/msg-1": RAW });
    const source = wrapsSource(s3);
    for (const init of [
      { rawBody: "{not json" },
      { rawBody: "" },
      { rawBody: "null" },
      { rawBody: '"raw/msg-1"' },
      { rawBody: "[]" },
      { body: { detail: { subject: "no key" } } },
      { body: { detail: { rawS3Key: 42 } } },
      { body: { detail: { rawS3Key: "" } } },
    ]) {
      expect(await source.receive(wrapsRequest(init))).toEqual({
        reject: 400,
      });
    }
    expect(s3.calls).toEqual([]);
  });

  it("answers 404 for NoSuchKey, so Wraps stops retrying", async () => {
    const source = wrapsSource(fakeS3({}));
    expect(await source.receive(wrapsRequest())).toEqual({ reject: 404 });
    // matched by name too, for any copy of the SDK
    const byName = wrapsSource({
      send: async () => {
        throw Object.assign(new Error("gone"), { name: "NoSuchKey" });
      },
    });
    expect(await byName.receive(wrapsRequest())).toEqual({ reject: 404 });
  });

  it("answers 502 for any other S3 error, so Wraps retries", async () => {
    expect(await wrapsSource(failingS3).receive(wrapsRequest())).toEqual({
      reject: 502,
    });
    const denied = wrapsSource({
      send: async () => {
        throw Object.assign(new Error("Access Denied"), {
          name: "AccessDenied",
        });
      },
    });
    expect(await denied.receive(wrapsRequest())).toEqual({ reject: 502 });
    const brokenBody = wrapsSource({
      send: async () => ({ Body: erroringStream() }),
    });
    expect(await brokenBody.receive(wrapsRequest())).toEqual({ reject: 502 });
  });

  it("answers 413 for an object past maxBytes", async () => {
    const small = RAW.byteLength - 1;
    // by ContentLength, before reading
    expect(
      await wrapsSource(fakeS3({ "raw/msg-1": RAW }), small).receive(
        wrapsRequest(),
      ),
    ).toEqual({ reject: 413 });
    // by bytes read, when S3 sends no length
    for (const shape of ["node", "web", "bytes", "mixin"] as const) {
      const s3 = fakeS3({ "raw/msg-1": RAW }, shape);
      const noLength: WrapsInboundS3Client = {
        send: async (command) => {
          const { Body } = (await s3.send(command)) as { Body: unknown };
          return { Body };
        },
      };
      expect(
        await wrapsSource(noLength, small).receive(wrapsRequest()),
      ).toEqual({ reject: 413 });
    }
  });

  it("answers 413 for an event body past 1 MB", async () => {
    const source = wrapsSource(fakeS3({ "raw/msg-1": RAW }));
    const huge = { ...envelope("raw/msg-1"), pad: "x".repeat(1_100_000) };
    expect(await source.receive(wrapsRequest({ body: huge }))).toEqual({
      reject: 413,
    });
  });

  it("throws at setup for an empty key", () => {
    expect(() =>
      wrapsInbound({ key: "", bucket: BUCKET, region: "us-east-1" }),
    ).toThrow(/non-empty key/);
  });

  it("creates an S3Client from region on first use when no client is given", async () => {
    vi.resetModules();
    const created: unknown[] = [];
    const sent: unknown[] = [];
    vi.doMock("@aws-sdk/client-s3", () => ({
      S3Client: class {
        constructor(config: unknown) {
          created.push(config);
        }
        async send(command: { input: unknown }) {
          sent.push(command.input);
          return { Body: RAW.slice(), ContentLength: RAW.byteLength };
        }
      },
      GetObjectCommand: class {
        constructor(readonly input: unknown) {}
      },
    }));
    try {
      const fresh = await import("./wraps");
      const source = fresh.wrapsInbound({
        key: KEY,
        bucket: BUCKET,
        region: "eu-west-1",
      });
      expect(created).toEqual([]);
      await source.receive(wrapsRequest());
      const result = await source.receive(wrapsRequest());
      expect("raw" in result).toBe(true);
      expect(created).toEqual([{ region: "eu-west-1" }]);
      expect(sent).toEqual([
        { Bucket: BUCKET, Key: "raw/msg-1" },
        { Bucket: BUCKET, Key: "raw/msg-1" },
      ]);
    } finally {
      vi.doUnmock("@aws-sdk/client-s3");
      vi.resetModules();
    }
  });

  it("throws a clear error when the S3 SDK isn't installed", async () => {
    vi.resetModules();
    vi.doMock("@aws-sdk/client-s3", () => {
      throw new Error("Cannot find package '@aws-sdk/client-s3'");
    });
    try {
      const fresh = await import("./wraps");
      const source = fresh.wrapsInbound({
        key: KEY,
        bucket: BUCKET,
        region: "us-east-1",
      });
      await expect(source.receive(wrapsRequest())).rejects.toThrow(
        /wrapsInbound needs @aws-sdk\/client-s3/,
      );
    } finally {
      vi.doUnmock("@aws-sdk/client-s3");
      vi.resetModules();
    }
  });

  it("re-exports wrapsMailer for one-import setup", () => {
    expect(typeof wrapsMailer).toBe("function");
  });
});

describe("import hygiene", () => {
  const source = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8");
  const staticImport = (pkg: string) =>
    new RegExp(
      `(^|\\n)\\s*(import|export)\\s+(?!type\\b)[^;]*?from\\s+["']${pkg}`,
    );

  it("the root and the raw relay never mention a provider SDK", () => {
    for (const path of ["./index.ts", "./inbound/raw-relay.ts"]) {
      const text = source(path);
      expect(text).not.toContain("@aws-sdk/client-s3");
      expect(text).not.toContain("@wraps.dev/email");
      expect(text).not.toMatch(/from\s+["']\.\/wraps["']/);
    }
  });

  it("wraps.ts loads the S3 SDK only with a dynamic import", () => {
    const text = source("./wraps.ts");
    expect(text).not.toMatch(staticImport("@aws-sdk/client-s3"));
    expect(text).toContain('import("@aws-sdk/client-s3")');
    expect(text).not.toContain("@wraps.dev/email");
  });
});
