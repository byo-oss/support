import { createAuthEndpoint } from "better-auth/api";
import * as z from "zod";
import { endpointRuntime } from "../adapter";
import { runSweep } from "../delivery";
import type { ResolvedSupportOptions } from "../options";

/**
 * `processSupportDeliveries`: `createAuthEndpoint.serverOnly`, no path,
 * returns `SupportSweepResult` from `runSweep`. Registered with or without a
 * mailer. Call it from a cron (`auth.api.processSupportDeliveries()`), again
 * while `hasMore` is true.
 */
export function sweepEndpoints(opts: ResolvedSupportOptions) {
  return {
    processSupportDeliveries: createAuthEndpoint.serverOnly(
      {
        method: "POST",
        body: z.object({}).optional(),
      },
      async (ctx) => runSweep(endpointRuntime(ctx, opts)),
    ),
  };
}
