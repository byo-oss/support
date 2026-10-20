// BYO_STUB: final owner N13. Signatures are final (contracts.md); bodies are neutral.
import type { SupportStorage } from "../options";

type StorageFactory = () => SupportStorage | Promise<SupportStorage>;

/** An in-memory `SupportStorage` for tests and local development. */
export type MemoryStorage = SupportStorage & {
  /** Stored keys, sorted. */
  readonly keys: string[];
  clear(): void;
};

export function memoryStorage(): MemoryStorage {
  return {
    keys: [],
    clear: () => {},
    put: async () => {},
    get: async () => null,
    delete: async () => {},
    deletePrefix: async () => {},
  };
}

export type TestSupportStorageOptions = {
  /** The same storage wired to a backend that fails; every method must throw. */
  failing: StorageFactory;
};

/**
 * The `SupportStorage` contract as a vitest suite: put/get round trip
 * (bytes, contentType, size), missing key → null, delete (also of a missing
 * key), deletePrefix removes exactly the prefix, inputs not mutated, failing
 * backend throws.
 */
export function testSupportStorage(
  _create: StorageFactory,
  _options: TestSupportStorageOptions,
): void {}
