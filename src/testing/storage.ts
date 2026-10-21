import { describe, expect, it } from "vitest";
import type { SupportStorage, SupportStoredObject } from "../options";

type StorageFactory = () => SupportStorage | Promise<SupportStorage>;

/** An in-memory `SupportStorage` for tests and local development. */
export type MemoryStorage = SupportStorage & {
  /** Stored keys, sorted. */
  readonly keys: string[];
  clear(): void;
};

/** A one-chunk stream over a copy of `bytes`. */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const copy = bytes.slice();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (copy.byteLength > 0) controller.enqueue(copy);
      controller.close();
    },
  });
}

/**
 * An in-memory `SupportStorage`. Bytes are copied on `put` and on every
 * `get`, so neither side can change what is stored. Not for production: the
 * blobs live in this process only.
 *
 * ```ts
 * import { memoryStorage } from "@byo-oss/support/testing"
 * support({ attachments: { storage: memoryStorage() } })
 * ```
 */
export function memoryStorage(): MemoryStorage {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  return {
    get keys() {
      return [...objects.keys()].sort();
    },
    clear() {
      objects.clear();
    },
    async put({ key, body, contentType }) {
      objects.set(key, { body: body.slice(), contentType });
    },
    async get(key): Promise<SupportStoredObject | null> {
      const object = objects.get(key);
      if (!object) return null;
      return {
        body: streamOf(object.body),
        contentType: object.contentType,
        size: object.body.byteLength,
      };
    },
    async delete(key) {
      objects.delete(key);
    },
    async deletePrefix(prefix) {
      if (!prefix) {
        throw new Error("[@byo-oss/support] deletePrefix needs a prefix");
      }
      for (const key of [...objects.keys()]) {
        if (key.startsWith(prefix)) objects.delete(key);
      }
    },
  };
}

export type TestSupportStorageOptions = {
  /** The same storage wired to a backend that fails; every method must throw. */
  failing: StorageFactory;
};

/** Reads a stored object's stream to the end. */
async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Every byte value, then a pattern, `size` bytes long. */
function bytes(size: number, seed = 0): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + seed) % 256;
  return out;
}

/**
 * The `SupportStorage` contract as a vitest suite: put/get round trip
 * (bytes, contentType, size), missing key → null, delete (also of a missing
 * key), deletePrefix removes exactly the prefix, inputs not mutated, failing
 * backend throws.
 *
 * Call it at the top level of a test file with a factory that builds your
 * storage on a fake (or a throwaway real) backend. Each check writes under
 * its own random `byo-storage-test/<uuid>/` prefix, so it can run against a
 * shared bucket:
 *
 * ```ts
 * import { testSupportStorage } from "@byo-oss/support/testing"
 * testSupportStorage(() => myStorage({ client: fakeClient }), {
 *   failing: () => myStorage({ client: rejectingClient }),
 * })
 * ```
 */
export function testSupportStorage(
  create: StorageFactory,
  options: TestSupportStorageOptions,
): void {
  const scope = () => `byo-storage-test/${globalThis.crypto.randomUUID()}/`;

  describe("SupportStorage contract", () => {
    it("has put, get, delete and deletePrefix", async () => {
      const storage = await create();
      for (const method of ["put", "get", "delete", "deletePrefix"] as const) {
        expect(typeof storage[method]).toBe("function");
      }
    });

    it("round-trips bytes, contentType and size", async () => {
      const storage = await create();
      const key = `${scope()}file`;
      const body = bytes(1024);
      await storage.put({ key, body, contentType: "application/pdf" });
      const object = await storage.get(key);
      expect(object).not.toBeNull();
      expect(object?.contentType).toBe("application/pdf");
      expect(object?.size).toBe(1024);
      expect(object?.body).toBeInstanceOf(ReadableStream);
      const read = await readAll(object?.body as ReadableStream<Uint8Array>);
      expect(Array.from(read)).toEqual(Array.from(body));
    });

    it("round-trips an empty file and a larger one", async () => {
      const storage = await create();
      const prefix = scope();
      const large = bytes(300_000, 7);
      await storage.put({
        key: `${prefix}empty`,
        body: new Uint8Array(0),
        contentType: "text/plain",
      });
      await storage.put({
        key: `${prefix}large`,
        body: large,
        contentType: "application/zip",
      });
      const empty = await storage.get(`${prefix}empty`);
      expect(empty?.size).toBe(0);
      expect(
        (await readAll(empty?.body as ReadableStream<Uint8Array>)).byteLength,
      ).toBe(0);
      const big = await storage.get(`${prefix}large`);
      expect(big?.size).toBe(large.byteLength);
      const read = await readAll(big?.body as ReadableStream<Uint8Array>);
      expect(read.byteLength).toBe(large.byteLength);
      expect(read.every((value, i) => value === large[i])).toBe(true);
    });

    it("serves the same object more than once", async () => {
      const storage = await create();
      const key = `${scope()}file`;
      await storage.put({ key, body: bytes(64), contentType: "text/csv" });
      for (let i = 0; i < 2; i++) {
        const object = await storage.get(key);
        const read = await readAll(object?.body as ReadableStream<Uint8Array>);
        expect(Array.from(read)).toEqual(Array.from(bytes(64)));
      }
    });

    it("overwrites a key that is put again", async () => {
      const storage = await create();
      const key = `${scope()}file`;
      await storage.put({ key, body: bytes(10), contentType: "text/plain" });
      await storage.put({ key, body: bytes(3, 5), contentType: "image/png" });
      const object = await storage.get(key);
      expect(object?.contentType).toBe("image/png");
      expect(object?.size).toBe(3);
      const read = await readAll(object?.body as ReadableStream<Uint8Array>);
      expect(Array.from(read)).toEqual(Array.from(bytes(3, 5)));
    });

    it("resolves null for a missing key", async () => {
      const storage = await create();
      expect(await storage.get(`${scope()}missing`)).toBeNull();
    });

    it("deletes a key, and deleting a missing key resolves", async () => {
      const storage = await create();
      const prefix = scope();
      await storage.put({
        key: `${prefix}a`,
        body: bytes(8),
        contentType: "text/plain",
      });
      await storage.put({
        key: `${prefix}b`,
        body: bytes(8),
        contentType: "text/plain",
      });
      await storage.delete(`${prefix}a`);
      expect(await storage.get(`${prefix}a`)).toBeNull();
      expect(await storage.get(`${prefix}b`)).not.toBeNull();
      await expect(storage.delete(`${prefix}a`)).resolves.toBeUndefined();
      await expect(storage.delete(`${prefix}never`)).resolves.toBeUndefined();
    });

    it("deletePrefix removes exactly the keys under the prefix", async () => {
      const storage = await create();
      const root = scope();
      const keep = [
        `${root}support/org_ab/x`,
        `${root}support/org_a`,
        `${root}support/_/y`,
        `${root}other/org_a/z`,
      ];
      const remove = [
        `${root}support/org_a/1`,
        `${root}support/org_a/2`,
        `${root}support/org_a/nested/3`,
      ];
      for (const key of [...keep, ...remove]) {
        await storage.put({ key, body: bytes(4), contentType: "text/plain" });
      }
      await storage.deletePrefix(`${root}support/org_a/`);
      for (const key of remove) expect(await storage.get(key)).toBeNull();
      for (const key of keep) expect(await storage.get(key)).not.toBeNull();
      // nothing left under it: a second run resolves
      await expect(
        storage.deletePrefix(`${root}support/org_a/`),
      ).resolves.toBeUndefined();
    });

    it("doesn't change its inputs, and later changes to them don't reach the stored object", async () => {
      const storage = await create();
      const key = `${scope()}file`;
      const input = { key, body: bytes(32), contentType: "image/webp" };
      const before = structuredClone(input);
      await storage.put(input);
      expect(input).toEqual(before);
      input.body.fill(0);
      const object = await storage.get(key);
      const read = await readAll(object?.body as ReadableStream<Uint8Array>);
      expect(Array.from(read)).toEqual(Array.from(before.body));
    });

    it("throws from every method when the backend fails", async () => {
      const storage = await options.failing();
      const key = `${scope()}file`;
      await expect(
        storage.put({ key, body: bytes(4), contentType: "text/plain" }),
      ).rejects.toThrow();
      await expect(storage.get(key)).rejects.toThrow();
      await expect(storage.delete(key)).rejects.toThrow();
      await expect(storage.deletePrefix(scope())).rejects.toThrow();
    });
  });
}
