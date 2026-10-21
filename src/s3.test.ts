import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupportStorage } from "./options";
import { type S3StorageClient, s3Storage } from "./s3";
import { memoryStorage, testSupportStorage } from "./testing/storage";

// ---------------------------------------------------------------------------
// A fake S3, shaped the way the SDK answers
// ---------------------------------------------------------------------------

type BodyShape = "bytes" | "web" | "node" | "mixin";

type FakeS3 = S3StorageClient & {
  objects: Map<string, { body: Uint8Array; contentType: string }>;
  calls: { name: string; input: Record<string, unknown> }[];
};

function nodeBody(bytes: Uint8Array) {
  return Readable.from([Buffer.from(bytes)]);
}

function fakeS3(shape: BodyShape = "mixin"): FakeS3 {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  const calls: FakeS3["calls"] = [];
  const bodyOf = (bytes: Uint8Array) => {
    switch (shape) {
      case "bytes":
        return bytes.slice();
      case "web":
        return new Blob([bytes.slice()]).stream();
      case "node":
        return nodeBody(bytes);
      case "mixin":
        // the SDK's Node body: a stream with transformTo* helpers
        return Object.assign(nodeBody(bytes), {
          transformToWebStream: () => new Blob([bytes.slice()]).stream(),
        });
    }
  };
  return {
    objects,
    calls,
    async send(command) {
      const name = (command as object).constructor.name;
      const input = (command as { input: Record<string, unknown> }).input;
      calls.push({ name, input });
      expect(input.Bucket).toBe("support-bucket");
      if (command instanceof PutObjectCommand) {
        const body = input.Body as Uint8Array;
        expect(input.ContentLength).toBe(body.byteLength);
        objects.set(input.Key as string, {
          body: body.slice(),
          contentType: input.ContentType as string,
        });
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const object = objects.get(input.Key as string);
        if (!object) {
          throw new NoSuchKey({ message: "missing", $metadata: {} });
        }
        return {
          Body: bodyOf(object.body),
          ContentType: object.contentType,
          ContentLength: object.body.byteLength,
        };
      }
      if (command instanceof DeleteObjectCommand) {
        objects.delete(input.Key as string);
        return {};
      }
      if (command instanceof ListObjectsV2Command) {
        const prefix = input.Prefix as string;
        const max = Math.min(
          (input.MaxKeys as number | undefined) ?? 1000,
          1000,
        );
        const keys = [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .sort();
        const after = input.ContinuationToken as string | undefined;
        const start = after ? keys.findIndex((key) => key > after) : 0;
        const page = start < 0 ? [] : keys.slice(start, start + max);
        const truncated = start >= 0 && start + max < keys.length;
        return {
          Contents: page.map((Key) => ({ Key })),
          KeyCount: page.length,
          IsTruncated: truncated,
          ...(truncated ? { NextContinuationToken: page.at(-1) } : {}),
        };
      }
      if (command instanceof DeleteObjectsCommand) {
        const del = input.Delete as { Objects: { Key: string }[] };
        expect(del.Objects.length).toBeLessThanOrEqual(1000);
        for (const { Key } of del.Objects) objects.delete(Key);
        return {};
      }
      throw new Error(`unexpected command ${name}`);
    },
  };
}

const failingS3: S3StorageClient = {
  send: async () => {
    throw Object.assign(new Error("access denied"), {
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403 },
    });
  },
};

const s3 = (client: S3StorageClient) =>
  s3Storage({ bucket: "support-bucket", region: "us-east-1", client });

const failingMemory: SupportStorage = {
  put: async () => {
    throw new Error("disk full");
  },
  get: async () => {
    throw new Error("disk gone");
  },
  delete: async () => {
    throw new Error("disk gone");
  },
  deletePrefix: async () => {
    throw new Error("disk gone");
  },
};

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

// ---------------------------------------------------------------------------
// The contract suite
// ---------------------------------------------------------------------------

describe("memoryStorage", () => {
  testSupportStorage(() => memoryStorage(), { failing: () => failingMemory });

  it("lists its keys sorted, and clear() empties it", async () => {
    const storage = memoryStorage();
    for (const key of ["support/b/2", "support/a/1", "support/_/3"]) {
      await storage.put({
        key,
        body: new Uint8Array([1]),
        contentType: "text/plain",
      });
    }
    expect(storage.keys).toEqual(["support/_/3", "support/a/1", "support/b/2"]);
    storage.clear();
    expect(storage.keys).toEqual([]);
  });

  it("refuses an empty prefix rather than deleting everything", async () => {
    const storage = memoryStorage();
    await storage.put({
      key: "support/a/1",
      body: new Uint8Array([1]),
      contentType: "text/plain",
    });
    await expect(storage.deletePrefix("")).rejects.toThrow(/needs a prefix/);
    expect(storage.keys).toEqual(["support/a/1"]);
  });
});

describe("s3Storage (fake S3 client)", () => {
  testSupportStorage(() => s3(fakeS3()), { failing: () => s3(failingS3) });

  for (const shape of ["bytes", "web", "node"] as const) {
    describe(`with a ${shape} body`, () => {
      testSupportStorage(() => s3(fakeS3(shape)), {
        failing: () => s3(failingS3),
      });
    });
  }

  it("sends Bucket, Key, ContentType and ContentLength on put", async () => {
    const client = fakeS3();
    await s3(client).put({
      key: "support/org_1/a",
      body: new Uint8Array([1, 2, 3]),
      contentType: "application/pdf",
    });
    expect(client.calls).toEqual([
      {
        name: "PutObjectCommand",
        input: {
          Bucket: "support-bucket",
          Key: "support/org_1/a",
          Body: new Uint8Array([1, 2, 3]),
          ContentType: "application/pdf",
          ContentLength: 3,
        },
      },
    ]);
  });

  it("deletePrefix pages through more than 1000 keys, 1000 per DeleteObjects", async () => {
    const client = fakeS3();
    const storage = s3(client);
    const pad = (n: number) => String(n).padStart(4, "0");
    for (let i = 0; i < 2500; i++) {
      client.objects.set(`support/org_1/${pad(i)}`, {
        body: new Uint8Array([i % 256]),
        contentType: "text/plain",
      });
    }
    client.objects.set("support/org_10/keep", {
      body: new Uint8Array([1]),
      contentType: "text/plain",
    });
    client.objects.set("support/_/keep", {
      body: new Uint8Array([1]),
      contentType: "text/plain",
    });

    await storage.deletePrefix("support/org_1/");

    expect([...client.objects.keys()].sort()).toEqual([
      "support/_/keep",
      "support/org_10/keep",
    ]);
    const lists = client.calls.filter((c) => c.name === "ListObjectsV2Command");
    const deletes = client.calls.filter(
      (c) => c.name === "DeleteObjectsCommand",
    );
    expect(lists.length).toBeGreaterThanOrEqual(3);
    expect(
      deletes.map(
        (c) => (c.input.Delete as { Objects: unknown[] }).Objects.length,
      ),
    ).toEqual([1000, 1000, 500]);
    expect(lists.every((c) => c.input.Prefix === "support/org_1/")).toBe(true);
    // the second and later pages carry the continuation token
    expect(lists[0]?.input.ContinuationToken).toBeUndefined();
    expect(lists[1]?.input.ContinuationToken).toEqual(expect.any(String));
  });

  it("deletePrefix with nothing under the prefix sends no DeleteObjects", async () => {
    const client = fakeS3();
    await s3(client).deletePrefix("support/none/");
    expect(client.calls.map((c) => c.name)).toEqual(["ListObjectsV2Command"]);
  });

  it("deletePrefix throws when DeleteObjects reports per-key errors", async () => {
    const client = fakeS3();
    client.objects.set("support/org_1/a", {
      body: new Uint8Array([1]),
      contentType: "text/plain",
    });
    const partial: S3StorageClient = {
      async send(command) {
        if (command instanceof DeleteObjectsCommand) {
          return {
            Errors: [
              { Key: "support/org_1/a", Code: "AccessDenied", Message: "no" },
            ],
          };
        }
        return client.send(command);
      },
    };
    await expect(s3(partial).deletePrefix("support/org_1/")).rejects.toThrow(
      /could not delete 1 object/,
    );
  });

  it("refuses an empty prefix without calling S3", async () => {
    const client = fakeS3();
    await expect(s3(client).deletePrefix("")).rejects.toThrow(/needs a prefix/);
    expect(client.calls).toEqual([]);
  });

  it("reads a missing key as null by NoSuchKey or a 404, and rethrows anything else", async () => {
    const notFound: S3StorageClient = {
      send: async () => {
        throw Object.assign(new Error("not found"), {
          name: "NotFound",
          $metadata: { httpStatusCode: 404 },
        });
      },
    };
    expect(await s3(notFound).get("support/_/x")).toBeNull();
    expect(await s3(fakeS3()).get("support/_/x")).toBeNull();
    await expect(s3(failingS3).get("support/_/x")).rejects.toThrow(
      "access denied",
    );
  });

  it("falls back to application/octet-stream when S3 sends no type", async () => {
    const bare: S3StorageClient = {
      send: async () => ({ Body: new TextEncoder().encode("hi") }),
    };
    const object = await s3(bare).get("support/_/x");
    expect(object?.contentType).toBe("application/octet-stream");
    expect(object?.size).toBe(2);
    expect(await text(object?.body as ReadableStream<Uint8Array>)).toBe("hi");
  });

  it("refuses an empty bucket at setup", () => {
    expect(() => s3Storage({ bucket: "", region: "us-east-1" })).toThrow(
      /needs a bucket/,
    );
  });
});

describe("s3Storage without a client", () => {
  afterEach(() => {
    vi.doUnmock("@aws-sdk/client-s3");
    vi.resetModules();
  });

  it("creates one S3Client from the options on first use", async () => {
    const created: unknown[] = [];
    const sent: unknown[] = [];
    vi.resetModules();
    vi.doMock("@aws-sdk/client-s3", async (importOriginal) => {
      const real = await importOriginal<typeof import("@aws-sdk/client-s3")>();
      return {
        ...real,
        S3Client: class {
          constructor(config: unknown) {
            created.push(config);
          }
          async send(command: unknown) {
            sent.push(command);
            return {};
          }
        },
      };
    });
    const { s3Storage: fresh } = await import("./s3");
    const storage = fresh({
      bucket: "support-bucket",
      region: "auto",
      endpoint: "https://r2.example.test",
      forcePathStyle: true,
      credentials: { accessKeyId: "id", secretAccessKey: "secret" },
    });
    expect(created).toEqual([]);
    await storage.put({
      key: "support/_/a",
      body: new Uint8Array([1]),
      contentType: "text/plain",
    });
    await storage.delete("support/_/a");
    expect(created).toEqual([
      {
        region: "auto",
        endpoint: "https://r2.example.test",
        forcePathStyle: true,
        credentials: { accessKeyId: "id", secretAccessKey: "secret" },
      },
    ]);
    expect(sent).toHaveLength(2);
  });

  it("throws a clear error when the S3 SDK isn't installed", async () => {
    vi.resetModules();
    vi.doMock("@aws-sdk/client-s3", () => {
      throw new Error("Cannot find package '@aws-sdk/client-s3'");
    });
    const { s3Storage: fresh } = await import("./s3");
    await expect(
      fresh({ bucket: "support-bucket", region: "us-east-1" }).get("k"),
    ).rejects.toThrow(/s3Storage needs @aws-sdk\/client-s3/);
  });
});

describe("import hygiene", () => {
  it("imports @aws-sdk/client-s3 only with a dynamic import() in s3.ts", () => {
    const source = readFileSync(new URL("./s3.ts", import.meta.url), "utf8");
    const staticImports = source
      .split("\n")
      .filter((line) => /^\s*(import|export)\b/.test(line))
      .filter((line) => line.includes("@aws-sdk/"));
    expect(staticImports).toEqual([]);
    expect(source).toMatch(
      /await import\("@aws-sdk\/client-s3"\)|import\("@aws-sdk\/client-s3"\)/,
    );
  });

  it("never imports the S3 SDK from the storage suite or memoryStorage", () => {
    const source = readFileSync(
      new URL("./testing/storage.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("@aws-sdk/");
  });
});
