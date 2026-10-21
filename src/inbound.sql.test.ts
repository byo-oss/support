// PRD acceptance #28: the same Message-ID posted concurrently twice yields one
// message, and both requests are answered 2xx. PGlite has one connection, so
// the race is forced: an adapter hook holds both requests at the duplicate
// check until each has passed it, then both insert and the unique
// `emailMessageId` constraint refuses the second.
import { generateKeyPairSync } from "node:crypto";
import { memoryMailer } from "@byo-oss/mailer";
import { dkimSign } from "mailauth";
import { afterEach, describe, expect, it } from "vitest";
import { authRuntime } from "./adapter";
import { type InboundResult, receiveEmail } from "./inbound/receive";
import type { DkimResolver } from "./inbound/verify";
import type { SupportInboundSource } from "./options";
import { createSqlTestAuth } from "./test-sql";
import type { AdapterCall } from "./test-utils";

type Harness = Awaited<ReturnType<typeof createSqlTestAuth>>;
let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const MESSAGE_ID = "<race@customer.test>";

/** A DKIM key for `domain`, served by a stub resolver that knows nothing else. */
function testDkim(domain: string) {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKey = pair.privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
  const publicKey = pair.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
  const resolver: DkimResolver = async (name, rrtype) => {
    if (rrtype === "TXT" && name === `test._domainkey.${domain}`) {
      return [[`v=DKIM1; k=rsa; p=${publicKey}`]];
    }
    throw Object.assign(new Error(`ENOTFOUND ${name}`), { code: "ENOTFOUND" });
  };
  const sign = async (raw: string) => {
    const { signatures } = await dkimSign(raw, {
      signatureData: [{ signingDomain: domain, selector: "test", privateKey }],
    });
    return new TextEncoder().encode(signatures + raw);
  };
  return { resolver, sign };
}

/** A message from alice@customer.test; unsigned, it needs no DNS and is stored unverified. */
function message(input: { messageId: string; headers?: string[] }): string {
  return [
    "From: Alice Example <alice@customer.test>",
    "To: support@help.test",
    "Subject: Invoice question",
    `Message-ID: ${input.messageId}`,
    "Date: Tue, 20 Oct 2026 09:30:00 +0000",
    ...(input.headers ?? []),
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Where is my invoice?",
    "",
  ].join("\r\n");
}

const source: SupportInboundSource = {
  receive: async (request) => ({
    raw: new Uint8Array(await request.arrayBuffer()),
  }),
};

/**
 * Holds the first two duplicate checks for `messageId` until both have
 * arrived, so neither request has inserted when the other checks. Later
 * checks (the confirmation after a failed insert) pass straight through.
 */
function raceAt(messageId: string) {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const calls = { messageCreates: 0, ticketCreates: 0 };
  const before = async ({ method, model, args }: AdapterCall) => {
    if (method === "create" && model === "supportMessage") {
      const data = args.data as { emailMessageId?: string | null };
      if (data.emailMessageId === messageId) calls.messageCreates++;
    }
    if (method === "create" && model === "supportTicket") calls.ticketCreates++;
    if (method !== "findOne" || model !== "supportMessage") return;
    const where = args.where as { field: string; value: unknown }[];
    if (
      !where.some((w) => w.field === "emailMessageId" && w.value === messageId)
    )
      return;
    if (arrived >= 2) return;
    arrived++;
    if (arrived === 2) open();
    await gate;
  };
  return { before, calls, arrived: () => arrived };
}

async function setup(messageId: string) {
  const race = raceAt(messageId);
  harness = await createSqlTestAuth(
    {
      mailer: memoryMailer(),
      email: {
        from: "Acme Support <support@help.test>",
        replyDomain: "help.test",
        appUrl: "https://app.test",
      },
      inbound: { source },
    },
    { adapter: { before: race.before } },
  );
  return { ...harness, race };
}

const post = (auth: Harness["auth"], raw: string) =>
  auth.handler(
    new Request("http://localhost:3000/api/auth/support/inbound", {
      method: "POST",
      headers: { "content-type": "message/rfc822" },
      body: raw,
    }),
  );

describe("inbound dedupe on PGlite", () => {
  it("stores a concurrently posted Message-ID once and answers both 202", async () => {
    const { auth, db, race } = await setup(MESSAGE_ID);
    const raw = message({ messageId: MESSAGE_ID });
    const responses = await Promise.all([post(auth, raw), post(auth, raw)]);

    expect(responses.map((res) => res.status)).toEqual([202, 202]);
    for (const res of responses) expect(await res.json()).toEqual({ ok: true });
    // both passed the duplicate check and both tried to insert
    expect(race.arrived()).toBe(2);
    expect(race.calls.ticketCreates).toBe(2);
    expect(race.calls.messageCreates).toBe(2);

    const messages = await db
      .selectFrom("supportMessage")
      .selectAll()
      .where("emailMessageId", "=", MESSAGE_ID)
      .execute();
    expect(messages).toHaveLength(1);
    // the loser's ticket was removed with its failed first message
    const tickets = await db.selectFrom("supportTicket").selectAll().execute();
    expect(tickets).toHaveLength(1);
    expect(tickets[0]?.id).toBe(messages[0]?.ticketId);
    const all = await db.selectFrom("supportMessage").selectAll().execute();
    expect(all).toHaveLength(1);
  });

  it("treats a lost race on an appended reply as a duplicate too", async () => {
    const replyId = "<race-reply@customer.test>";
    const { auth, db, race } = await setup(replyId);
    const rt = await authRuntime(auth, "inbound.sql.test");
    const dkim = testDkim("customer.test");
    const deps = { resolver: dkim.resolver };
    // verified mail from the requester appends; the first message opens the ticket
    const first = await receiveEmail(
      rt,
      await dkim.sign(message({ messageId: MESSAGE_ID })),
      deps,
    );
    if (first.status !== "created") throw new Error(JSON.stringify(first));

    const raw = await dkim.sign(
      message({ messageId: replyId, headers: [`In-Reply-To: ${MESSAGE_ID}`] }),
    );
    const results: InboundResult[] = await Promise.all([
      receiveEmail(rt, raw, deps),
      receiveEmail(rt, raw, deps),
    ]);
    expect(results).toContainEqual({ status: "dropped", reason: "duplicate" });
    expect(results).toContainEqual(
      expect.objectContaining({ status: "appended", ticketId: first.ticketId }),
    );
    expect(race.arrived()).toBe(2);
    expect(race.calls.messageCreates).toBe(2);
    const rows = await db
      .selectFrom("supportMessage")
      .selectAll()
      .where("emailMessageId", "=", replyId)
      .execute();
    expect(rows).toHaveLength(1);
    // the losing request wrote nothing else: two replies, one ticket
    const all = await db.selectFrom("supportMessage").selectAll().execute();
    expect(all).toHaveLength(2);
    expect(
      await db.selectFrom("supportTicket").selectAll().execute(),
    ).toHaveLength(1);
  });
});
