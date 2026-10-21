import { describe, expect, it } from "vitest";
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

type Snapshot = { method: string; url: string; headers: [string, string][] };

function snapshot(request: Request): Snapshot {
  return {
    method: request.method,
    url: request.url,
    headers: [...request.headers.entries()],
  };
}

async function outcomeOf(source: SupportInboundSource, request: Request) {
  try {
    return { threw: false as const, result: await source.receive(request) };
  } catch (error) {
    return { threw: true as const, error };
  }
}

/**
 * The `SupportInboundSource` contract as a vitest suite: accepted request →
 * `{ raw }` equal to `fixtures.raw`; bad secret → `{ reject: 401 }`; failing
 * backend → reject ≥ 500 or throw. Call it at the top level of a test file
 * with factories that build your source on a fake backend:
 *
 * ```ts
 * import { testSupportInboundSource } from "@byo-oss/support/testing"
 * testSupportInboundSource(() => mySource({ client: fakeClient }), {
 *   failing: () => mySource({ client: rejectingClient }),
 *   fixtures: { accepted, raw, unauthenticated },
 * })
 * ```
 *
 * Request factories are called once per check, since a body can be read only
 * once. The suite also checks that `receive` resolves exactly one of `raw`
 * (a `Uint8Array`) or `reject` (an HTTP status), gives the same bytes when the
 * same message arrives twice, and leaves the request's method, URL and headers
 * as they were.
 *
 * This is ESM only (it imports `vitest`).
 */
export function testSupportInboundSource(
  create: SourceFactory,
  options: TestSupportInboundSourceOptions,
): void {
  const { fixtures } = options;

  describe("SupportInboundSource contract", () => {
    it("has a receive function", async () => {
      const source = await create();
      expect(typeof source.receive).toBe("function");
    });

    it("returns the raw bytes of an accepted request", async () => {
      const source = await create();
      const result = await source.receive(await fixtures.accepted());
      expect("reject" in result).toBe(false);
      expect("raw" in result).toBe(true);
      if (!("raw" in result)) return;
      expect(result.raw).toBeInstanceOf(Uint8Array);
      expect(Array.from(result.raw)).toEqual(Array.from(fixtures.raw));
    });

    it("returns the same bytes when the same message arrives again", async () => {
      const source = await create();
      const first = await source.receive(await fixtures.accepted());
      const second = await source.receive(await fixtures.accepted());
      expect("raw" in first && "raw" in second).toBe(true);
      if (!("raw" in first) || !("raw" in second)) return;
      expect(Array.from(second.raw)).toEqual(Array.from(first.raw));
    });

    it("rejects a wrong or missing secret with 401", async () => {
      const source = await create();
      const result = await source.receive(await fixtures.unauthenticated());
      expect(result).toEqual({ reject: 401 });
    });

    it("doesn't change the request's method, URL or headers", async () => {
      const source = await create();
      for (const make of [fixtures.accepted, fixtures.unauthenticated]) {
        const request = await make();
        const before = snapshot(request);
        await source.receive(request);
        expect(snapshot(request)).toEqual(before);
      }
    });

    it("rejects with 5xx or throws when its backend fails, so the relay retries", async () => {
      const source = await options.failing();
      const outcome = await outcomeOf(source, await fixtures.accepted());
      if (outcome.threw) return;
      expect("raw" in outcome.result).toBe(false);
      expect("reject" in outcome.result).toBe(true);
      if (!("reject" in outcome.result)) return;
      expect(Number.isInteger(outcome.result.reject)).toBe(true);
      expect(outcome.result.reject).toBeGreaterThanOrEqual(500);
      expect(outcome.result.reject).toBeLessThan(600);
    });
  });
}
