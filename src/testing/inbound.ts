// BYO_STUB: final owner N11b. Signature is final (contracts.md); body registers no tests yet.
import type { SupportInboundSource } from "../options";

type SourceFactory = () => SupportInboundSource | Promise<SupportInboundSource>;
type RequestFactory = () => Request | Promise<Request>;

export type TestSupportInboundSourceOptions = {
  /**
   * The same source wired to a backend that fails (a fake S3 that throws, a
   * body stream that errors). The suite expects `receive` to resolve
   * `{ reject: n }` with n ≥ 500, or to throw, so the relay retries.
   */
  failing: SourceFactory;
  fixtures: {
    /** A request the source accepts. */
    accepted: RequestFactory;
    /** The raw bytes `accepted` must yield. */
    raw: Uint8Array;
    /** A request with a wrong or missing secret: must give `{ reject: 401 }`. */
    unauthenticated: RequestFactory;
  };
};

/**
 * The `SupportInboundSource` contract as a vitest suite: accepted request →
 * `{ raw }` equal to `fixtures.raw`; bad secret → `{ reject: 401 }`; failing
 * backend → reject ≥ 500 or throw.
 */
export function testSupportInboundSource(
  _create: SourceFactory,
  _options: TestSupportInboundSourceOptions,
): void {}
