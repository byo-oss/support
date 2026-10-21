import { APIError, createAuthEndpoint } from "better-auth/api";
import type { Status } from "better-call";
import { endpointRuntime } from "../adapter";
import type { OkResponse } from "../client";
import { SUPPORT_ERROR_CODES } from "../error-codes";
import { receiveEmail } from "../inbound/receive";
import type { ResolvedSupportOptions } from "../options";

/** A source's `{ reject }` outside 400–599 is a broken source: answered 502, so the relay retries. */
function rejectStatus(status: number): number {
  return Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : 502;
}

/**
 * `receiveSupportEmail`: POST `/support/inbound`, credential-free,
 * `disableBody: true`, `requireRequest: true`. Without `inbound`: 404 `INBOUND_NOT_CONFIGURED`.
 * Otherwise `opts.inbound.source.receive(request)`: `{ reject }` is answered
 * with that status, a throw with 502, `{ raw }` goes to `receiveEmail` (with
 * `inbound.resolver` for the DKIM check) and is answered 202 whatever it decided.
 */
export function inboundEndpoints(opts: ResolvedSupportOptions) {
  return {
    /**
     * Receives one raw message from the mail relay. The source authenticates
     * the relay (the endpoint itself takes no session) and reads the bytes;
     * `receiveEmail` decides what to store. Answers 202 `{ ok: true }` for
     * every message it took, dropped and duplicate ones included, so the
     * relay stops retrying.
     */
    receiveSupportEmail: createAuthEndpoint(
      "/support/inbound",
      {
        method: "POST",
        disableBody: true,
        requireRequest: true,
      },
      async (ctx) => {
        const inbound = opts.inbound;
        if (!inbound) {
          throw APIError.from(
            "NOT_FOUND",
            SUPPORT_ERROR_CODES.INBOUND_NOT_CONFIGURED,
          );
        }
        let received: Awaited<ReturnType<typeof inbound.source.receive>>;
        try {
          received = await inbound.source.receive(ctx.request);
        } catch (error) {
          ctx.context.logger.error(
            "[@byo-oss/support] the inbound source failed",
            error,
          );
          throw new APIError("BAD_GATEWAY", {
            message: "The inbound source failed",
          });
        }
        if ("reject" in received) {
          const status = rejectStatus(received.reject);
          throw new APIError(
            status as Status,
            { message: "Rejected by the inbound source" },
            {},
            status,
          );
        }
        await receiveEmail(endpointRuntime(ctx, opts), received.raw, {
          resolver: inbound.resolver,
        });
        ctx.setStatus(202);
        return { ok: true } satisfies OkResponse;
      },
    ),
  };
}
