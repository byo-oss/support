// BYO_STUB: final owner N13. Signature is final (contracts.md); body is neutral.
// Loads @aws-sdk/client-s3 with a dynamic import() only when no client is given.
import type { SupportStorage } from "./options";

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

/** `SupportStorage` on S3 or any S3-compatible store. Every method throws on an S3 error. */
export function s3Storage(_options: S3StorageOptions): SupportStorage {
  return {
    put: async () => {},
    get: async () => null,
    delete: async () => {},
    deletePrefix: async () => {},
  };
}
