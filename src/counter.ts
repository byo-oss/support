import type { DBTransactionAdapter } from "better-auth";
import type { SupportCounterRow } from "./schema";

export const TICKET_COUNTER_KEY = "ticket";

const increment = (adapter: DBTransactionAdapter) =>
  adapter.incrementOne<SupportCounterRow>({
    model: "supportCounter",
    where: [{ field: "key", value: TICKET_COUNTER_KEY }],
    increment: { value: 1 },
  });

/**
 * The next ticket number, starting at 1.
 *
 * Increments the `"ticket"` counter row atomically. With no row yet, creates
 * it with value 1; if that create fails because another request created the
 * row first (the unique `key`), increments once more. Call it with the base
 * adapter, outside any transaction: a failed insert aborts a Postgres
 * transaction.
 *
 * The first-party adapters implement `incrementOne` natively and add 1 in
 * the database, atomically. On an adapter without one, better-auth
 * falls back to a compare-and-swap that also guards on the value it read, so
 * it never hands out a number twice either; after 5 lost rounds it throws
 * instead. The unique `number` on the ticket insert stays the backstop for an
 * adapter whose `updateMany` doesn't check its `where` atomically: callers
 * treat a conflict as "allocate again" (at most 3 times).
 */
export async function allocateTicketNumber(
  adapter: DBTransactionAdapter,
): Promise<number> {
  const bumped = await increment(adapter);
  if (bumped) return bumped.value;
  try {
    await adapter.create<Omit<SupportCounterRow, "id">, SupportCounterRow>({
      model: "supportCounter",
      data: { key: TICKET_COUNTER_KEY, value: 1 },
    });
    return 1;
  } catch (createError) {
    const retried = await increment(adapter);
    if (retried) return retried.value;
    throw new Error("[@byo-oss/support] could not allocate a ticket number", {
      cause: createError,
    });
  }
}
