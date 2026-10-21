import { createFileRoute } from "@tanstack/react-router";
import { sweepAll } from "@byo-oss/core";
import { auth } from "../../../lib/auth";

// Delayed and retried mail, auto-closing solved tickets and stale-upload
// pruning only happen when something calls this. Point a scheduler at it
// every minute; the e2e test calls it once.
export const Route = createFileRoute("/api/cron/support")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const secret = process.env.CRON_SECRET;
        if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
          return new Response("Unauthorized", { status: 401 });
        }
        return Response.json(await sweepAll(auth, { budgetMs: 20_000 }));
      },
    },
  },
});
