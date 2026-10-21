// PRD acceptance #8: inbound email (J5). `.eml` templates live in
// test/fixtures/inbound; each test fills in the placeholders and DKIM-signs
// the result with a key generated here, served by a stubbed DNS resolver
// that knows no DMARC record at all.
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ByoEvent } from "@byo-oss/core";
import { memoryMailer } from "@byo-oss/mailer";
import { dkimSign } from "mailauth";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { authRuntime, type SupportRuntime } from "./adapter";
import { storeInboundPart } from "./attachments";
import { SUPPORT_ERROR_CODES } from "./error-codes";
import { parseMessage, stripQuoted } from "./inbound/parse";
import {
  type InboundResult,
  type ReceiveEmailDeps,
  receiveEmail,
} from "./inbound/receive";
import { type DkimResolver, verifyAlignedDkim } from "./inbound/verify";
import { resolveMergedTicket } from "./merge";
import type {
  SupportInboundOptions,
  SupportInboundSource,
  SupportOptions,
} from "./options";
import type { SupportMessageRow, SupportTicketRow } from "./schema";
import {
  createTestAuth,
  STAFF_ORG_ID,
  seedSupportWorld,
  signUpUser,
} from "./test-utils";
import { createTicket } from "./tickets";

// ---------------------------------------------------------------------------
// DNS: one test key, published for a few sender domains; no DMARC anywhere
// ---------------------------------------------------------------------------

const dns = vi.hoisted(() => {
  const records = new Map<string, string>();
  const queried: string[] = [];
  const resolve = async (name: string, rrtype: string) => {
    queried.push(`${rrtype} ${name}`);
    const txt = rrtype === "TXT" ? records.get(name.toLowerCase()) : undefined;
    if (txt) return [[txt]];
    throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), {
      code: "ENOTFOUND",
    });
  };
  return { records, queried, resolve };
});

// the endpoint uses system DNS (no test seam): serve the same records there
vi.mock("node:dns/promises", () => ({
  Resolver: class {
    resolve(name: string, rrtype: string) {
      return dns.resolve(name, rrtype);
    }
  },
}));

// storeInboundPart is N13's; by default the real one runs, and a test can
// make it report a stored part, a drop or a throw
vi.mock("./attachments", async (importOriginal) => {
  const original = await importOriginal<typeof import("./attachments")>();
  return { ...original, storeInboundPart: vi.fn(original.storeInboundPart) };
});

// resolveMergedTicket is N14's; by default the real one runs, and a test can
// make a thread resolve to another ticket
vi.mock("./merge", async (importOriginal) => {
  const original = await importOriginal<typeof import("./merge")>();
  return {
    ...original,
    resolveMergedTicket: vi.fn(original.resolveMergedTicket),
  };
});

const SELECTOR = "byo";
const SIGNING_DOMAINS = ["acme.test", "customer.test", "other.test"];
let privateKey = "";

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKey = pair.privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
  const publicKey = pair.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
  for (const domain of SIGNING_DOMAINS) {
    dns.records.set(
      `${SELECTOR}._domainkey.${domain}`,
      `v=DKIM1; k=rsa; p=${publicKey}`,
    );
  }
});

const resolver: DkimResolver = dns.resolve;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPLY_DOMAIN = "help.test";
const SUPPORT_FROM = "Acme Support <support@help.test>";
const SUPPORT_TO = "support@help.test";
const RELAY_SECRET = "relay-secret-for-tests";

type Template =
  | "plain"
  | "reply"
  | "auto-reply"
  | "bounce"
  | "attachment"
  | "html-only";

type MailInput = {
  template?: Template;
  from?: string;
  fromName?: string;
  to?: string;
  subject?: string;
  messageId?: string;
  body?: string;
  /** Extra header lines, e.g. `In-Reply-To: <id>`. */
  headers?: string[];
};

let sequence = 0;
const nextMessageId = () => `<msg-${++sequence}@mail.test>`;

/** A filled-in template, with CRLF line endings. */
function compose(input: MailInput = {}): string {
  const from = input.from ?? "alice@customer.test";
  const values: Record<string, string> = {
    from,
    fromName: input.fromName ?? "Alice Example",
    fromDomain: from.slice(from.lastIndexOf("@") + 1),
    to: input.to ?? SUPPORT_TO,
    subject: input.subject ?? "Invoice question",
    messageId: input.messageId ?? nextMessageId(),
    body: input.body ?? "Where is my invoice?",
  };
  const template = readFileSync(
    new URL(
      `../test/fixtures/inbound/${input.template ?? "plain"}.eml`,
      import.meta.url,
    ),
    "utf8",
  );
  const headerLines = (input.headers ?? []).map((line) => `${line}\n`).join("");
  return template
    .replace(/^\{\{headers\}\}\n/m, headerLines)
    .replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? "")
    .replace(/\r?\n/g, "\r\n");
}

const bytes = (text: string) => new TextEncoder().encode(text);

/** The message unsigned. */
const unsigned = (input: MailInput = {}) => bytes(compose(input));

/** The message DKIM-signed by `domain` (default: the From domain). */
async function signed(
  input: MailInput = {},
  options: { domain?: string; headerList?: string } = {},
): Promise<Uint8Array> {
  const message = compose(input);
  const from = input.from ?? "alice@customer.test";
  const { signatures, errors } = await dkimSign(message, {
    signatureData: [
      {
        signingDomain: options.domain ?? from.slice(from.lastIndexOf("@") + 1),
        selector: SELECTOR,
        privateKey,
      },
    ],
    ...(options.headerList ? { headerList: options.headerList } : {}),
  });
  expect(errors).toEqual([]);
  return bytes(signatures + message);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A relay source as an app would write one: bearer secret, raw body. */
function fakeSource(): SupportInboundSource & { fail: boolean } {
  return {
    fail: false,
    async receive(request) {
      if (this.fail) throw new Error("relay storage unavailable");
      if (request.headers.get("authorization") !== `Bearer ${RELAY_SECRET}`) {
        return { reject: 401 };
      }
      return { raw: new Uint8Array(await request.arrayBuffer()) };
    },
  };
}

type LogLine = { level: string; message: string };

async function setup(
  inbound: Partial<SupportInboundOptions> = {},
  extra: Partial<SupportOptions> = {},
  log: { throws?: boolean } = {},
) {
  const events: ByoEvent[] = [];
  // every level better-auth's logger writes, kept instead of printed
  const logs: LogLine[] = [];
  const source = fakeSource();
  const auth = createTestAuth(
    {
      staffOrganizationId: STAFF_ORG_ID,
      mailer: memoryMailer(),
      email: {
        from: SUPPORT_FROM,
        replyDomain: REPLY_DOMAIN,
        appUrl: "https://app.test",
      },
      inbound: { source, ...inbound },
      onEvent: (event) => void events.push(event),
      ...extra,
    },
    {
      authOptions: {
        logger: {
          level: "debug",
          log: (level, message) => {
            if (log.throws) throw new Error("logger down");
            logs.push({ level, message });
          },
        },
      },
    },
  );
  const world = await seedSupportWorld(auth);
  const rt = await authRuntime(auth, "inbound.test");
  events.length = 0;
  logs.length = 0;

  const receive = (raw: Uint8Array, deps: ReceiveEmailDeps = {}) =>
    receiveEmail(rt, raw, { resolver, ...deps });
  const post = (raw: Uint8Array | string, secret = RELAY_SECRET) =>
    auth.handler(
      new Request("http://localhost:3000/api/auth/support/inbound", {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "message/rfc822",
        },
        body: raw as BodyInit,
      }),
    );
  return { auth, rt, world, events, logs, source, receive, post };
}

async function tickets(rt: SupportRuntime): Promise<SupportTicketRow[]> {
  return rt.adapter.findMany<SupportTicketRow>({
    model: "supportTicket",
    limit: 1000,
  });
}

async function ticketById(
  rt: SupportRuntime,
  id: string,
): Promise<SupportTicketRow> {
  const row = await rt.adapter.findOne<SupportTicketRow>({
    model: "supportTicket",
    where: [{ field: "id", value: id }],
  });
  if (!row) throw new Error(`no ticket ${id}`);
  return row;
}

async function messagesOf(
  rt: SupportRuntime,
  ticketId: string,
): Promise<SupportMessageRow[]> {
  const rows = await rt.adapter.findMany<SupportMessageRow>({
    model: "supportMessage",
    where: [{ field: "ticketId", value: ticketId }],
    limit: 1000,
  });
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

async function allMessages(rt: SupportRuntime): Promise<SupportMessageRow[]> {
  return rt.adapter.findMany<SupportMessageRow>({
    model: "supportMessage",
    limit: 1000,
  });
}

function expectCreated(result: InboundResult) {
  if (result.status !== "created") {
    throw new Error(`expected created, got ${JSON.stringify(result)}`);
  }
  return result;
}

function expectAppended(result: InboundResult) {
  if (result.status !== "appended") {
    throw new Error(`expected appended, got ${JSON.stringify(result)}`);
  }
  return result;
}

/** A web ticket owned by a verified customer, as the app would create it. */
async function webTicket(
  rt: SupportRuntime,
  owner: { user: { id: string } },
  overrides: { organizationId?: string; visibility?: "organization" } = {},
) {
  const { ticket } = await createTicket(rt, {
    subject: "Billing",
    body: "Hello from the app",
    channel: "web",
    userId: owner.user.id,
    verified: true,
    actorId: owner.user.id,
    ...overrides,
  });
  return ticket;
}

const tokenAddress = (ticket: SupportTicketRow) =>
  `support+${ticket.replyToken}@${REPLY_DOMAIN}`;

/**
 * The message as SES stores it on receipt: its verdict headers prepended
 * above everything the sender wrote (and above the DKIM signature, which
 * doesn't cover them), as in a real SES inbound header block.
 */
function sesReceived(
  raw: Uint8Array,
  verdicts: { spam?: string; virus?: string },
): Uint8Array {
  const lines = [
    ...(verdicts.spam ? [`X-SES-Spam-Verdict: ${verdicts.spam}`] : []),
    ...(verdicts.virus ? [`X-SES-Virus-Verdict: ${verdicts.virus}`] : []),
  ];
  const head = lines.map((line) => `${line}\r\n`).join("");
  return new Uint8Array([...bytes(head), ...raw]);
}

/** The support plugin's drop log lines. */
const dropLogs = (logs: LogLine[]) =>
  logs.filter((line) => line.message.includes("dropped an inbound email"));

/** A ticket of the verified customer, waiting on the customer (`pending`). */
async function pendingTicket(
  rt: SupportRuntime,
  owner: { user: { id: string } },
) {
  const ticket = await webTicket(rt, owner);
  await rt.adapter.update({
    model: "supportTicket",
    where: [{ field: "id", value: ticket.id }],
    update: { status: "pending" },
  });
  return { ...ticket, status: "pending" as const };
}

const mockedStore = vi.mocked(storeInboundPart);
const mockedResolve = vi.mocked(resolveMergedTicket);
beforeEach(() => {
  mockedStore.mockClear();
  mockedResolve.mockClear();
  dns.queried.length = 0;
});

// ---------------------------------------------------------------------------
// Parsing and DKIM
// ---------------------------------------------------------------------------

describe("parseMessage", () => {
  it("lowercases addresses, collects recipients and strips the quoted reply", async () => {
    const parsed = await parseMessage(
      unsigned({
        template: "reply",
        from: "Alice@Customer.TEST",
        to: "Support <SUPPORT@help.test>",
        messageId: "<abc@customer.test>",
        body: "Here it is: INV-42.",
        headers: [
          "Cc: bob@customer.test",
          "Delivered-To: support+aaaa@help.test",
          "X-Original-To: help@help.test",
          "In-Reply-To: <out-1@help.test>",
          "References: <first@help.test> <out-1@help.test>",
        ],
      }),
    );
    expect(parsed).toMatchObject({
      messageId: "<abc@customer.test>",
      from: { address: "alice@customer.test", name: "Alice Example" },
      subject: "Re: Invoice question",
      text: "Here it is: INV-42.",
      inReplyTo: "<out-1@help.test>",
      references: ["<first@help.test>", "<out-1@help.test>"],
      returnPath: null,
    });
    expect(parsed.recipients.sort()).toEqual([
      "bob@customer.test",
      "help@help.test",
      "support+aaaa@help.test",
      "support@help.test",
    ]);
    expect(parsed.headers["x-original-to"]).toBe("help@help.test");
  });

  it("reads the null return path as an empty string and keeps attachment parts", async () => {
    const bounce = await parseMessage(unsigned({ template: "bounce" }));
    expect(bounce.returnPath).toBe("");
    const withParts = await parseMessage(unsigned({ template: "attachment" }));
    expect(
      withParts.attachments.map((part) => [part.filename, part.contentType]),
    ).toEqual([
      ["report.pdf", "application/pdf"],
      ["../../notes.txt", "text/plain"],
    ]);
    expect(withParts.attachments[0]?.content).toBeInstanceOf(Uint8Array);
  });

  it("turns an HTML-only body into text", async () => {
    const parsed = await parseMessage(
      unsigned({ template: "html-only", body: "Hello from HTML" }),
    );
    expect(parsed.text).toContain("Hello from HTML");
    expect(parsed.text).not.toContain("<p>");
  });

  it("keeps the whole text when there is nothing above the quote", () => {
    expect(stripQuoted("> only quoted")).toBe("> only quoted");
    expect(stripQuoted("Thanks!\n\nOn Mon, Bob wrote:\n> hi")).toBe("Thanks!");
  });
});

describe("verifyAlignedDkim", () => {
  it("passes an aligned signature from a domain with no DMARC record", async () => {
    const raw = await signed({ from: "alice@customer.test" });
    expect(await verifyAlignedDkim(raw, "customer.test", { resolver })).toBe(
      true,
    );
    expect(dns.records.has("_dmarc.customer.test")).toBe(false);
  });

  it("aligns relaxed: a subdomain From signed by the organizational domain", async () => {
    const raw = await signed(
      { from: "bob@mail.customer.test" },
      { domain: "customer.test" },
    );
    expect(
      await verifyAlignedDkim(raw, "mail.customer.test", { resolver }),
    ).toBe(true);
  });

  it("fails an unaligned, unsigned, altered or double-From message", async () => {
    const other = await signed(
      { from: "alice@customer.test" },
      { domain: "other.test" },
    );
    expect(await verifyAlignedDkim(other, "customer.test", { resolver })).toBe(
      false,
    );
    expect(
      await verifyAlignedDkim(unsigned(), "customer.test", { resolver }),
    ).toBe(false);

    const good = new TextDecoder().decode(await signed());
    const altered = bytes(good.replace("Where is my invoice?", "Pay to X"));
    expect(
      await verifyAlignedDkim(altered, "customer.test", { resolver }),
    ).toBe(false);

    // a second From added after signing: one domain's signature must not
    // vouch for another address a reader may see
    const doubleFrom = bytes(`From: ceo@other.test\r\n${good}`);
    expect(
      await verifyAlignedDkim(doubleFrom, "customer.test", { resolver }),
    ).toBe(false);
    expect(
      await verifyAlignedDkim(doubleFrom, "other.test", { resolver }),
    ).toBe(false);
  });

  it("ignores an Authentication-Results header already in the message", async () => {
    const raw = unsigned({
      headers: [
        "Authentication-Results: mx.help.test; dkim=pass header.d=customer.test; dmarc=pass",
      ],
    });
    expect(await verifyAlignedDkim(raw, "customer.test", { resolver })).toBe(
      false,
    );
  });

  it("is false (never throws) when DNS fails", async () => {
    const failing: DkimResolver = async () => {
      throw new Error("SERVFAIL");
    };
    expect(
      await verifyAlignedDkim(await signed(), "customer.test", {
        resolver: failing,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// receiveEmail
// ---------------------------------------------------------------------------

describe("receiveEmail: new tickets", () => {
  it("opens a ticket for verified mail from an unknown sender", async () => {
    const { rt, receive, events } = await setup();
    const result = expectCreated(
      await receive(
        await signed({
          template: "reply",
          messageId: "<first@customer.test>",
          body: "My invoice is missing.",
        }),
      ),
    );
    const ticket = await ticketById(rt, result.ticketId);
    expect(ticket).toMatchObject({
      subject: "Re: Invoice question",
      status: "open",
      channel: "email",
      verified: true,
      userId: null,
      requesterEmail: "alice@customer.test",
      requesterName: "Alice Example",
      requesterSeenAt: null,
    });
    const [message] = await messagesOf(rt, ticket.id);
    expect(message).toMatchObject({
      id: result.messageId,
      kind: "reply",
      authorType: "customer",
      body: "My invoice is missing.",
      channel: "email",
      verified: true,
      emailMessageId: "<first@customer.test>",
      authorEmail: "alice@customer.test",
      userId: null,
    });
    expect(events.map((event) => event.type)).toEqual([
      "support.ticket.created",
    ]);
    expect(events[0]).toMatchObject({ actorId: null });
  });

  it("makes inbound tickets organization-less and private, even for an org member", async () => {
    const { rt, receive, world } = await setup();
    const result = expectCreated(
      await receive(await signed({ from: world.customer.user.email })),
    );
    const ticket = await ticketById(rt, result.ticketId);
    expect(ticket.organizationId).toBeNull();
    expect(ticket.visibility).toBe("private");
    // verified mail from a verified account is that account's ticket
    expect(ticket.userId).toBe(world.customer.user.id);
    expect(ticket.requesterEmail).toBeNull();
  });

  it("counts aligned DKIM from a domain with no DMARC record as verified", async () => {
    const { rt, receive } = await setup();
    const result = expectCreated(
      await receive(
        await signed(
          { from: "bob@mail.customer.test" },
          { domain: "customer.test" },
        ),
      ),
    );
    expect((await ticketById(rt, result.ticketId)).verified).toBe(true);
    expect(
      [...dns.records.keys()].some((key) => key.startsWith("_dmarc")),
    ).toBe(false);
  });

  it("stores unverified mail flagged, never linked to the account of its From", async () => {
    const { rt, receive, world } = await setup();
    const forged = expectCreated(
      await receive(unsigned({ from: world.customer.user.email })),
    );
    const ticket = await ticketById(rt, forged.ticketId);
    expect(ticket).toMatchObject({
      verified: false,
      userId: null,
      requesterEmail: world.customer.user.email,
      organizationId: null,
      visibility: "private",
    });
    const [message] = await messagesOf(rt, ticket.id);
    expect(message).toMatchObject({ userId: null, verified: false });
  });

  it("links verified mail only to an account whose email is verified", async () => {
    const { rt, receive, auth } = await setup();
    const unconfirmed = await signUpUser(auth, "new@customer.test");
    const result = expectCreated(
      await receive(await signed({ from: unconfirmed.user.email })),
    );
    expect(await ticketById(rt, result.ticketId)).toMatchObject({
      verified: true,
      userId: null,
      requesterEmail: "new@customer.test",
    });
  });

  it("drops mail that doesn't thread when newTickets is off", async () => {
    const { rt, receive } = await setup({ newTickets: false });
    expect(await receive(await signed())).toEqual({
      status: "dropped",
      reason: "no_new_tickets",
    });
    expect(await tickets(rt)).toHaveLength(0);
  });

  it("falls back to a subject and caps an oversized message", async () => {
    const { rt, receive } = await setup({ maxBytes: 2000 });
    const result = expectCreated(await receive(await signed({ subject: "" })));
    expect((await ticketById(rt, result.ticketId)).subject).toBe(
      "(no subject)",
    );
    expect(await receive(await signed({ body: "x".repeat(3000) }))).toEqual({
      status: "dropped",
      reason: "too_large",
    });
  });

  it("drops mail without a sender, and garbage that has none either", async () => {
    const { receive } = await setup();
    expect(await receive(bytes("Subject: hi\r\n\r\nno from\r\n"))).toEqual({
      status: "dropped",
      reason: "no_sender",
    });
  });
});

describe("receiveEmail: threading and the append rule", () => {
  it("appends verified mail from the requester by reply token", async () => {
    const { rt, receive, world, events } = await setup();
    const ticket = await webTicket(rt, world.customer);
    await rt.adapter.update({
      model: "supportTicket",
      where: [{ field: "id", value: ticket.id }],
      update: { status: "pending" },
    });
    events.length = 0;
    const result = expectAppended(
      await receive(
        await signed({
          template: "reply",
          from: world.customer.user.email,
          // the token is matched case-insensitively
          to: tokenAddress(ticket).toUpperCase(),
          body: "Here is INV-42.",
        }),
      ),
    );
    expect(result.ticketId).toBe(ticket.id);
    const messages = await messagesOf(rt, ticket.id);
    const reply = messages.find((message) => message.id === result.messageId);
    expect(reply).toMatchObject({
      body: "Here is INV-42.",
      userId: world.customer.user.id,
      authorEmail: null,
      channel: "email",
      verified: true,
    });
    const after = await ticketById(rt, ticket.id);
    // a customer reply reopens; an email reply never marks the ticket seen
    expect(after.status).toBe("open");
    expect(after.requesterSeenAt?.getTime()).toBe(
      ticket.requesterSeenAt?.getTime(),
    );
    expect(events.map((event) => event.type)).toContain(
      "support.customer.replied",
    );
    expect(
      events.find((event) => event.type === "support.customer.replied"),
    ).toMatchObject({ actorId: world.customer.user.id });
  });

  it("records the status change an email reply causes on the email channel", async () => {
    const { rt, receive, world } = await setup();
    const ticket = await pendingTicket(rt, world.customer);
    expectAppended(
      await receive(
        await signed({
          template: "reply",
          from: world.customer.user.email,
          to: tokenAddress(ticket),
        }),
      ),
    );
    const status = (await messagesOf(rt, ticket.id)).find(
      (message) => message.kind === "event",
    );
    expect(status).toMatchObject({
      data: { type: "status", from: "pending", to: "open" },
      authorType: "customer",
      channel: "email",
    });
  });

  it("threads by In-Reply-To, then by References", async () => {
    const { rt, receive } = await setup();
    const first = expectCreated(
      await receive(await signed({ messageId: "<root@customer.test>" })),
    );
    const byInReplyTo = expectAppended(
      await receive(
        await signed({
          template: "reply",
          headers: ["In-Reply-To: <root@customer.test>"],
        }),
      ),
    );
    expect(byInReplyTo.ticketId).toBe(first.ticketId);

    const byReferences = expectAppended(
      await receive(
        await signed({
          template: "reply",
          headers: [
            "References: <unknown@elsewhere.test> <root@customer.test> <also-unknown@elsewhere.test>",
          ],
        }),
      ),
    );
    expect(byReferences.ticketId).toBe(first.ticketId);
    expect(await messagesOf(rt, first.ticketId)).toHaveLength(3);
    expect(await tickets(rt)).toHaveLength(1);
  });

  it("prefers the reply token over In-Reply-To", async () => {
    const { rt, receive, world } = await setup();
    const other = expectCreated(
      await receive(
        await signed({
          from: world.customer.user.email,
          messageId: "<other@acme.test>",
        }),
      ),
    );
    const ticket = await webTicket(rt, world.customer);
    const result = expectAppended(
      await receive(
        await signed({
          from: world.customer.user.email,
          to: tokenAddress(ticket),
          headers: ["In-Reply-To: <other@acme.test>"],
        }),
      ),
    );
    expect(result.ticketId).toBe(ticket.id);
    expect(result.ticketId).not.toBe(other.ticketId);
  });

  it("never appends unverified mail, even from the requester's address", async () => {
    const { rt, receive, world } = await setup();
    const ticket = await webTicket(rt, world.customer);
    const result = expectCreated(
      await receive(
        unsigned({
          from: world.customer.user.email,
          to: tokenAddress(ticket),
        }),
      ),
    );
    expect(result.ticketId).not.toBe(ticket.id);
    expect(await messagesOf(rt, ticket.id)).toHaveLength(1);
    expect(await ticketById(rt, result.ticketId)).toMatchObject({
      verified: false,
      userId: null,
      requesterEmail: world.customer.user.email,
    });
    // no link back to the thread it claimed
    const events = (await messagesOf(rt, result.ticketId)).filter(
      (message) => message.kind === "event",
    );
    expect(events).toEqual([]);
  });

  it("never appends verified mail from someone who isn't the requester", async () => {
    const { rt, receive, world } = await setup();
    const ticket = await webTicket(rt, world.customer);
    const result = expectCreated(
      await receive(
        await signed({
          from: world.outsider.user.email,
          to: tokenAddress(ticket),
        }),
      ),
    );
    expect(result.ticketId).not.toBe(ticket.id);
    expect(await messagesOf(rt, ticket.id)).toHaveLength(1);
    expect(await ticketById(rt, result.ticketId)).toMatchObject({
      userId: world.outsider.user.id,
      organizationId: null,
      visibility: "private",
    });
  });

  it("doesn't let a teammate append to a private ticket, but does on an org-shared one", async () => {
    const { rt, receive, world } = await setup();
    const privateTicket = await webTicket(rt, world.customer, {
      organizationId: world.customerOrg.id,
    });
    const shared = await webTicket(rt, world.customer, {
      organizationId: world.customerOrg.id,
      visibility: "organization",
    });
    expectCreated(
      await receive(
        await signed({
          from: world.teammate.user.email,
          to: tokenAddress(privateTicket),
        }),
      ),
    );
    const appended = expectAppended(
      await receive(
        await signed({
          from: world.teammate.user.email,
          to: tokenAddress(shared),
        }),
      ),
    );
    expect(appended.ticketId).toBe(shared.id);
    const reply = (await messagesOf(rt, shared.id)).find(
      (message) => message.id === appended.messageId,
    );
    expect(reply?.userId).toBe(world.teammate.user.id);
  });

  it("appends to an account-less ticket only from its requester address", async () => {
    const { rt, receive } = await setup();
    const first = expectCreated(
      await receive(await signed({ messageId: "<start@customer.test>" })),
    );
    const stranger = expectCreated(
      await receive(
        await signed({
          from: "mallory@other.test",
          headers: ["In-Reply-To: <start@customer.test>"],
        }),
      ),
    );
    expect(stranger.ticketId).not.toBe(first.ticketId);
    expect(await messagesOf(rt, first.ticketId)).toHaveLength(1);
  });

  it("opens a follow-up ticket for a reply to a closed ticket", async () => {
    const { rt, receive, world } = await setup();
    const closed = await webTicket(rt, world.customer);
    await rt.adapter.update({
      model: "supportTicket",
      where: [{ field: "id", value: closed.id }],
      update: { status: "closed" },
    });
    const result = expectCreated(
      await receive(
        await signed({
          template: "reply",
          from: world.customer.user.email,
          to: tokenAddress(closed),
        }),
      ),
    );
    expect(result.ticketId).not.toBe(closed.id);
    expect(await ticketById(rt, closed.id)).toMatchObject({ status: "closed" });
    expect(await messagesOf(rt, closed.id)).toHaveLength(1);
    const followup = await messagesOf(rt, result.ticketId);
    const followupEvent = followup.find((message) => message.kind === "event");
    expect(followupEvent?.data).toEqual({
      type: "followup_of",
      from: closed.id,
    });
    expect(followupEvent?.channel).toBe("email");
    expect(await ticketById(rt, result.ticketId)).toMatchObject({
      userId: world.customer.user.id,
      status: "open",
      organizationId: null,
      visibility: "private",
    });
  });

  it("opens the follow-up even with newTickets off; a stranger's reply is dropped", async () => {
    const { rt, receive, world } = await setup({ newTickets: false });
    const closed = await webTicket(rt, world.customer);
    await rt.adapter.update({
      model: "supportTicket",
      where: [{ field: "id", value: closed.id }],
      update: { status: "closed" },
    });
    const followup = expectCreated(
      await receive(
        await signed({
          from: world.customer.user.email,
          to: tokenAddress(closed),
        }),
      ),
    );
    expect(
      (await messagesOf(rt, followup.ticketId)).find(
        (message) => message.kind === "event",
      )?.data,
    ).toEqual({ type: "followup_of", from: closed.id });

    const open = await webTicket(rt, world.customer);
    expect(
      await receive(
        await signed({
          from: world.outsider.user.email,
          to: tokenAddress(open),
        }),
      ),
    ).toEqual({ status: "dropped", reason: "no_new_tickets" });
    expect(await tickets(rt)).toHaveLength(3);
  });

  it("acts on the ticket a merged thread resolves to", async () => {
    const { rt, receive, world } = await setup();
    const source = await webTicket(rt, world.customer);
    const target = await webTicket(rt, world.customer);
    mockedResolve.mockImplementationOnce(async (_adapter, ticket) => {
      expect(ticket.id).toBe(source.id);
      return target;
    });
    const result = expectAppended(
      await receive(
        await signed({
          template: "attachment",
          from: world.customer.user.email,
          to: tokenAddress(source),
        }),
      ),
    );
    expect(result.ticketId).toBe(target.id);
    expect(mockedStore.mock.calls[0]?.[1].ticket.id).toBe(target.id);
    expect(await messagesOf(rt, source.id)).toHaveLength(1);
    const onTarget = await messagesOf(rt, target.id);
    expect(onTarget.map((message) => message.kind)).toEqual([
      "reply",
      "reply",
      "event",
      "event",
    ]);
  });

  it("stores an overlong Message-ID hashed, dedupes it and threads replies to it", async () => {
    const { rt, receive } = await setup();
    const longId = `<${"x".repeat(3000)}@customer.test>`;
    const first = expectCreated(
      await receive(await signed({ messageId: longId })),
    );
    const [stored] = await messagesOf(rt, first.ticketId);
    expect(stored?.emailMessageId).toMatch(/^<[0-9a-f]{64}@inbound\.invalid>$/);
    expect(await receive(await signed({ messageId: longId }))).toEqual({
      status: "dropped",
      reason: "duplicate",
    });
    const reply = expectAppended(
      await receive(await signed({ headers: [`In-Reply-To: ${longId}`] })),
    );
    expect(reply.ticketId).toBe(first.ticketId);
  });
});

describe("receiveEmail: drop rules", () => {
  it("drops mail from our own address or any address at the reply domain", async () => {
    const { rt, receive } = await setup();
    expect(await receive(unsigned({ from: "support@help.test" }))).toEqual({
      status: "dropped",
      reason: "loop",
    });
    expect(await receive(unsigned({ from: "support+abc@HELP.test" }))).toEqual({
      status: "dropped",
      reason: "loop",
    });
    expect(await tickets(rt)).toHaveLength(0);
  });

  it("drops auto-replies", async () => {
    const { rt, receive } = await setup();
    expect(await receive(await signed({ template: "auto-reply" }))).toEqual({
      status: "dropped",
      reason: "auto_reply",
    });
    for (const header of [
      "Auto-Submitted: auto-generated",
      "Precedence: bulk",
      "Precedence: junk",
      "Precedence: auto_reply",
      "X-Auto-Response-Suppress: OOF",
    ]) {
      expect(await receive(await signed({ headers: [header] }))).toEqual({
        status: "dropped",
        reason: "auto_reply",
      });
    }
    expect(await tickets(rt)).toHaveLength(0);
    // `Auto-Submitted: no` is a person writing
    expectCreated(
      await receive(await signed({ headers: ["Auto-Submitted: no"] })),
    );
  });

  it("drops bounces: the null return path or a MAILER-DAEMON/postmaster sender", async () => {
    const { rt, receive } = await setup();
    expect(await receive(unsigned({ template: "bounce" }))).toEqual({
      status: "dropped",
      reason: "bounce",
    });
    expect(
      await receive(unsigned({ from: "postmaster@customer.test" })),
    ).toEqual({ status: "dropped", reason: "bounce" });
    expect(await receive(unsigned({ headers: ["Return-Path: <>"] }))).toEqual({
      status: "dropped",
      reason: "bounce",
    });
    expect(await tickets(rt)).toHaveLength(0);
  });

  it("drops a duplicate Message-ID before any write", async () => {
    const { rt, receive } = await setup();
    const raw = await signed({ messageId: "<once@customer.test>" });
    expectCreated(await receive(raw));
    expect(await receive(raw)).toEqual({
      status: "dropped",
      reason: "duplicate",
    });
    expect(await tickets(rt)).toHaveLength(1);
    expect(await allMessages(rt)).toHaveLength(1);
  });

  it("dedupes mail without a Message-ID by its bytes", async () => {
    const { rt, receive } = await setup();
    const raw = bytes(compose().replace(/^Message-ID: .*\r\n/m, ""));
    expectCreated(await receive(raw));
    expect(await receive(raw)).toEqual({
      status: "dropped",
      reason: "duplicate",
    });
    expect(await tickets(rt)).toHaveLength(1);
  });
});

describe("receiveEmail: caps", () => {
  it("per-sender cap counts verified mail only, so forged mail can't use it up", async () => {
    const { receive } = await setup({
      maxPerSenderPerHour: 2,
      maxUnverifiedPerHour: 100,
    });
    // three forged messages in the sender's name are stored, unverified
    for (let i = 0; i < 3; i++) {
      expectCreated(await receive(unsigned()));
    }
    expectCreated(await receive(await signed()));
    expectCreated(await receive(await signed()));
    expect(await receive(await signed())).toEqual({
      status: "dropped",
      reason: "sender_cap",
    });
    // another sender is unaffected
    expectCreated(await receive(await signed({ from: "carol@customer.test" })));
    // an hour later the window has moved on
    const later = new Date(Date.now() + 61 * 60_000);
    expectCreated(await receive(await signed(), { now: () => later }));
  });

  it("per-sender cap counts a linked account's messages too", async () => {
    const { receive, world } = await setup({ maxPerSenderPerHour: 1 });
    expectCreated(
      await receive(await signed({ from: world.customer.user.email })),
    );
    expect(
      await receive(await signed({ from: world.customer.user.email })),
    ).toEqual({ status: "dropped", reason: "sender_cap" });
  });

  it("unverified cap counts every unverified message, whoever sent it", async () => {
    const { receive } = await setup({
      maxUnverifiedPerHour: 2,
      maxPerSenderPerHour: 100,
    });
    expectCreated(await receive(unsigned({ from: "a@one.test" })));
    expectCreated(await receive(unsigned({ from: "b@two.test" })));
    expect(await receive(unsigned({ from: "c@three.test" }))).toEqual({
      status: "dropped",
      reason: "unverified_cap",
    });
    // verified mail isn't held back by it
    expectCreated(await receive(await signed()));
  });
});

describe("receiveEmail: SES spam and virus verdicts", () => {
  it("drops a message SES found a virus in, storing nothing, parts included", async () => {
    const { rt, receive, world, logs } = await setup();
    const ticket = await pendingTicket(rt, world.customer);
    const infected = sesReceived(
      await signed({
        template: "attachment",
        from: world.customer.user.email,
        to: tokenAddress(ticket),
      }),
      { spam: "PASS", virus: "FAIL" },
    );
    expect(await receive(infected)).toEqual({
      status: "dropped",
      reason: "virus",
    });
    expect(mockedStore).not.toHaveBeenCalled();
    expect(await tickets(rt)).toHaveLength(1);
    expect(await messagesOf(rt, ticket.id)).toHaveLength(1);
    expect((await ticketById(rt, ticket.id)).status).toBe("pending");
    expect(dropLogs(logs)).toEqual([
      {
        level: "warn",
        message:
          "[@byo-oss/support] dropped an inbound email: virus (sender domain: acme.test)",
      },
    ]);
    // a new ticket isn't opened for one either
    expect(
      await receive(
        sesReceived(await signed({ template: "attachment" }), {
          virus: "FAIL",
        }),
      ),
    ).toEqual({ status: "dropped", reason: "virus" });
    expect(await tickets(rt)).toHaveLength(1);
  });

  it("treats spam FAIL as unverified: never appended, never linked to the account", async () => {
    const { rt, receive, world } = await setup();
    const ticket = await pendingTicket(rt, world.customer);
    // the verified requester, DKIM-signed, by reply token: without the
    // verdict this appends (see the GRAY test)
    const result = expectCreated(
      await receive(
        sesReceived(
          await signed({
            template: "reply",
            from: world.customer.user.email,
            to: tokenAddress(ticket),
          }),
          { spam: "FAIL", virus: "PASS" },
        ),
      ),
    );
    expect(result.ticketId).not.toBe(ticket.id);
    expect(await messagesOf(rt, ticket.id)).toHaveLength(1);
    expect((await ticketById(rt, ticket.id)).status).toBe("pending");
    expect(await ticketById(rt, result.ticketId)).toMatchObject({
      verified: false,
      userId: null,
      requesterEmail: world.customer.user.email,
      organizationId: null,
      visibility: "private",
    });
    const [message] = await messagesOf(rt, result.ticketId);
    expect(message).toMatchObject({ verified: false, userId: null });
  });

  it("puts spam FAIL mail under the unverified rules: cap and newTickets", async () => {
    const capped = await setup({
      maxUnverifiedPerHour: 1,
      maxPerSenderPerHour: 100,
    });
    const spam = async (from: string) =>
      sesReceived(await signed({ from }), { spam: "FAIL" });
    expectCreated(await capped.receive(await spam("a@acme.test")));
    expect(await capped.receive(await spam("b@other.test"))).toEqual({
      status: "dropped",
      reason: "unverified_cap",
    });
    // verified mail isn't held back by it
    expectCreated(await capped.receive(await signed()));

    const closedInbox = await setup({ newTickets: false });
    expect(await closedInbox.receive(await spam("a@acme.test"))).toEqual({
      status: "dropped",
      reason: "no_new_tickets",
    });
  });

  it("changes nothing for GRAY, PROCESSING_FAILED or no verdict", async () => {
    const { rt, receive, world } = await setup();
    for (const verdict of ["GRAY", "PROCESSING_FAILED", undefined]) {
      const ticket = await pendingTicket(rt, world.customer);
      const result = expectAppended(
        await receive(
          sesReceived(
            await signed({
              template: "reply",
              from: world.customer.user.email,
              to: tokenAddress(ticket),
            }),
            { spam: verdict, virus: verdict },
          ),
        ),
      );
      expect(result.ticketId).toBe(ticket.id);
      const reply = (await messagesOf(rt, ticket.id)).find(
        (message) => message.id === result.messageId,
      );
      expect(reply).toMatchObject({
        verified: true,
        userId: world.customer.user.id,
      });
    }
  });

  it("reads only SES's copy, the first: a copy the sender added further down never counts", async () => {
    const { rt, receive, world } = await setup();
    // the sender's own FAIL copies under SES's PASS: SES's wins, it appends
    const ticket = await pendingTicket(rt, world.customer);
    expectAppended(
      await receive(
        sesReceived(
          await signed({
            template: "reply",
            from: world.customer.user.email,
            to: tokenAddress(ticket),
            headers: ["X-SES-Spam-Verdict: FAIL", "X-SES-Virus-Verdict: FAIL"],
          }),
          { spam: "PASS", virus: "PASS" },
        ),
      ),
    );

    // a forged PASS under SES's FAIL hides nothing
    expect(
      await receive(
        sesReceived(
          await signed({
            template: "attachment",
            headers: ["X-SES-Virus-Verdict: PASS"],
          }),
          { virus: "FAIL" },
        ),
      ),
    ).toEqual({ status: "dropped", reason: "virus" });
    const other = await pendingTicket(rt, world.customer);
    expectCreated(
      await receive(
        sesReceived(
          await signed({
            template: "reply",
            from: world.customer.user.email,
            to: tokenAddress(other),
            headers: ["X-SES-Spam-Verdict: PASS"],
          }),
          { spam: "FAIL" },
        ),
      ),
    );
    expect(await messagesOf(rt, other.id)).toHaveLength(1);
  });
});

describe("receiveEmail: attachment parts", () => {
  it("writes an attachment_dropped event per part when there is no storage", async () => {
    const { rt, receive } = await setup();
    const result = expectCreated(
      await receive(await signed({ template: "attachment" })),
    );
    expect(mockedStore).toHaveBeenCalledTimes(2);
    expect(mockedStore.mock.calls[0]?.[1]).toMatchObject({
      messageId: result.messageId,
      userId: null,
      part: { filename: "report.pdf", contentType: "application/pdf" },
    });
    const events = (await messagesOf(rt, result.ticketId)).filter(
      (message) => message.kind === "event",
    );
    expect(events.map((event) => event.data)).toEqual([
      { type: "attachment_dropped", to: "no_storage:report.pdf" },
      { type: "attachment_dropped", to: "no_storage:notes.txt" },
    ]);
    expect(events[0]).toMatchObject({
      authorType: "system",
      userId: null,
      body: "",
      channel: "email",
    });
  });

  it("writes the reason storeInboundPart reports, and nothing for a stored part", async () => {
    const { rt, receive } = await setup();
    mockedStore
      .mockResolvedValueOnce({ dropped: true, reason: "too_large" })
      .mockResolvedValueOnce({
        stored: {} as never,
      });
    const result = expectCreated(
      await receive(await signed({ template: "attachment" })),
    );
    const events = (await messagesOf(rt, result.ticketId)).filter(
      (message) => message.kind === "event",
    );
    expect(events.map((event) => event.data)).toEqual([
      { type: "attachment_dropped", to: "too_large:report.pdf" },
    ]);
  });

  it("keeps the message and records storage_failed when storing a part throws", async () => {
    const { rt, receive } = await setup();
    mockedStore.mockRejectedValueOnce(new Error("bucket gone"));
    const result = expectCreated(
      await receive(await signed({ template: "attachment" })),
    );
    const events = (await messagesOf(rt, result.ticketId)).filter(
      (message) => message.kind === "event",
    );
    expect(events.map((event) => event.data)).toEqual([
      { type: "attachment_dropped", to: "storage_failed:report.pdf" },
      { type: "attachment_dropped", to: "no_storage:notes.txt" },
    ]);
  });

  it("event rows don't count toward the caps", async () => {
    const { receive } = await setup({
      maxPerSenderPerHour: 2,
      maxUnverifiedPerHour: 2,
    });
    // each message with two dropped parts stores one reply and two events
    expectCreated(await receive(unsigned({ template: "attachment" })));
    expectCreated(await receive(unsigned({ template: "attachment" })));
    expect(await receive(unsigned())).toEqual({
      status: "dropped",
      reason: "unverified_cap",
    });
    expectCreated(await receive(await signed({ template: "attachment" })));
    expectCreated(await receive(await signed({ template: "attachment" })));
    expect(await receive(await signed())).toEqual({
      status: "dropped",
      reason: "sender_cap",
    });
  });
});

// ---------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------

describe("receiveSupportEmail (POST /support/inbound)", () => {
  it("answers 202 and stores verified mail (system DNS path)", async () => {
    const { rt, post } = await setup();
    const res = await post(await signed({ messageId: "<http@customer.test>" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    const [ticket] = await tickets(rt);
    expect(ticket).toMatchObject({ verified: true, channel: "email" });
    expect(dns.queried).toContain(`TXT ${SELECTOR}._domainkey.customer.test`);
  });

  it("checks DKIM with inbound.resolver from options, never system DNS", async () => {
    // the option's resolver serves the same test key, without the system
    // DNS stub (which records every query in `dns.queried`)
    const withKey = vi.fn<DkimResolver>(async (name, rrtype) => {
      const txt =
        rrtype === "TXT" ? dns.records.get(name.toLowerCase()) : undefined;
      if (txt) return [[txt]];
      throw Object.assign(new Error(`ENOTFOUND ${name}`), {
        code: "ENOTFOUND",
      });
    });
    const noKey = vi.fn<DkimResolver>(async (name) => {
      throw Object.assign(new Error(`ENOTFOUND ${name}`), {
        code: "ENOTFOUND",
      });
    });

    const good = await setup({ resolver: withKey });
    const thread = await webTicket(good.rt, good.world.customer);
    // one signed reply by token, posted byte for byte to both apps
    const reply = await signed({
      template: "reply",
      from: good.world.customer.user.email,
      to: tokenAddress(thread),
      messageId: "<resolver-option@acme.test>",
      body: "Here is INV-7.",
    });

    expect((await good.post(reply)).status).toBe(202);
    const appended = await messagesOf(good.rt, thread.id);
    expect(appended).toHaveLength(2);
    expect(appended[1]).toMatchObject({
      body: "Here is INV-7.",
      userId: good.world.customer.user.id,
      verified: true,
    });
    expect(withKey).toHaveBeenCalledWith(
      `${SELECTOR}._domainkey.acme.test`,
      "TXT",
    );

    const bad = await setup({ resolver: noKey });
    const other = await webTicket(bad.rt, bad.world.customer);
    await bad.rt.adapter.update({
      model: "supportTicket",
      where: [{ field: "id", value: other.id }],
      update: { replyToken: thread.replyToken },
    });
    expect((await bad.post(reply)).status).toBe(202);
    // unverified: never appended, stored as its own account-less ticket
    expect(await messagesOf(bad.rt, other.id)).toHaveLength(1);
    const created = (await tickets(bad.rt)).find((t) => t.id !== other.id);
    expect(created).toMatchObject({
      verified: false,
      userId: null,
      requesterEmail: bad.world.customer.user.email,
    });
    expect(noKey).toHaveBeenCalledWith(
      `${SELECTOR}._domainkey.acme.test`,
      "TXT",
    );

    expect(dns.queried).toEqual([]);
  });

  it("answers 202 for a duplicate Message-ID and adds no row", async () => {
    const { rt, post } = await setup();
    const raw = await signed({ messageId: "<retry@customer.test>" });
    expect((await post(raw)).status).toBe(202);
    const res = await post(raw);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(await tickets(rt)).toHaveLength(1);
    expect(await allMessages(rt)).toHaveLength(1);
  });

  it("answers 202 for a dropped message too", async () => {
    const { rt, post } = await setup();
    const res = await post(unsigned({ template: "auto-reply" }));
    expect(res.status).toBe(202);
    expect(await tickets(rt)).toHaveLength(0);
  });

  it("logs each drop once at warn: the reason and the sender domain, no address or body", async () => {
    const { rt, post, logs } = await setup();
    const res = await post(
      unsigned({
        template: "auto-reply",
        from: "alice@customer.test",
        body: "I am out of the office until Monday.",
      }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(await post(unsigned({ from: SUPPORT_TO }))).toHaveProperty(
      "status",
      202,
    );
    expect(
      await post(unsigned({ from: "MAILER-DAEMON@mx.other.test" })),
    ).toHaveProperty("status", 202);
    expect(dropLogs(logs)).toEqual([
      {
        level: "warn",
        message:
          "[@byo-oss/support] dropped an inbound email: auto_reply (sender domain: customer.test)",
      },
      {
        level: "warn",
        message:
          "[@byo-oss/support] dropped an inbound email: loop (sender domain: help.test)",
      },
      {
        level: "warn",
        message:
          "[@byo-oss/support] dropped an inbound email: bounce (sender domain: mx.other.test)",
      },
    ]);
    const all = logs.map((line) => line.message).join("\n");
    expect(all).not.toContain("alice@");
    expect(all).not.toContain("out of the office");
    expect(await tickets(rt)).toHaveLength(0);
  });

  it("logs nothing at warn for created and appended mail; a duplicate only at info", async () => {
    const { rt, post, world, logs } = await setup();
    const ticket = await pendingTicket(rt, world.customer);
    const created = await signed({ messageId: "<new@customer.test>" });
    expect((await post(created)).status).toBe(202);
    expect(
      (
        await post(
          await signed({
            template: "reply",
            from: world.customer.user.email,
            to: tokenAddress(ticket),
          }),
        )
      ).status,
    ).toBe(202);
    expect(await tickets(rt)).toHaveLength(2);
    expect(await messagesOf(rt, ticket.id)).toHaveLength(3);
    expect(logs.filter((line) => line.level === "warn")).toEqual([]);
    expect(logs.filter((line) => line.level === "error")).toEqual([]);

    // the relay's retry of a stored message
    expect((await post(created)).status).toBe(202);
    expect(logs.filter((line) => line.level === "warn")).toEqual([]);
    expect(dropLogs(logs)).toEqual([
      {
        level: "info",
        message:
          "[@byo-oss/support] dropped an inbound email: duplicate (sender domain: customer.test)",
      },
    ]);
  });

  it("answers 202 for a virus drop, and still 202 when the logger throws", async () => {
    // better-auth logs while it boots: break the logger after that
    const logger = { throws: false };
    const { rt, post } = await setup({}, {}, logger);
    logger.throws = true;
    const res = await post(
      sesReceived(await signed({ template: "attachment" }), { virus: "FAIL" }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(await tickets(rt)).toHaveLength(0);
    expect(mockedStore).not.toHaveBeenCalled();
  });

  it("passes the source's reject status through (bad relay secret: 401)", async () => {
    const { rt, post } = await setup();
    const res = await post(await signed(), "wrong-secret");
    expect(res.status).toBe(401);
    expect(await tickets(rt)).toHaveLength(0);
  });

  it("answers 502 when the source throws, so the relay retries", async () => {
    const { rt, post, source } = await setup();
    source.fail = true;
    const res = await post(await signed());
    expect(res.status).toBe(502);
    expect(await tickets(rt)).toHaveLength(0);
  });

  it("answers 404 INBOUND_NOT_CONFIGURED without the inbound option", async () => {
    const auth = createTestAuth({ staffOrganizationId: STAFF_ORG_ID });
    const res = await auth.handler(
      new Request("http://localhost:3000/api/auth/support/inbound", {
        method: "POST",
        body: compose(),
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      code: SUPPORT_ERROR_CODES.INBOUND_NOT_CONFIGURED.code,
    });
  });
});
