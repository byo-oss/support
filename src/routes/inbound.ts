// BYO_STUB: final owner N11a. Signature is final (contracts.md); returns no endpoints yet.
import type { ResolvedSupportOptions } from "../options";

/**
 * `receiveSupportEmail`: POST `/support/inbound`, credential-free,
 * `disableBody: true`, `requireRequest: true`. Without `inbound`: 404 `INBOUND_NOT_CONFIGURED`.
 * Otherwise `opts.inbound.source.receive(request)`: `{ reject }` is answered
 * with that status, a throw with 502, `{ raw }` goes to `receiveEmail` and is
 * answered 202 whatever it decided.
 */
export function inboundEndpoints(_opts: ResolvedSupportOptions) {
  return {};
}
