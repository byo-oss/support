import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentAttachmentResponse,
  AgentMessageResponse,
  AgentTicketDetailResponse,
  AgentTicketListResponse,
  AgentTicketResponse,
  CannedReplyListResponse,
  CannedReplyResponse,
  CustomerAttachmentResponse,
  CustomerMessageResponse,
  CustomerTicketDetailResponse,
  CustomerTicketListResponse,
  CustomerTicketResponse,
  DeleteTicketsResponse,
  OkResponse,
  TagListResponse,
  UpdateTicketsResponse,
  Wire,
} from "../../client";
import type { AgentCounts } from "../../queries";
import type {
  SupportCannedReplyRow,
  TicketPriority,
  TicketStatus,
  TicketVisibility,
} from "../../schema";
import {
  attempt,
  compact,
  DEFAULT_POLL_INTERVAL,
  unwrap,
  useSupportPagedResource,
  useSupportResource,
} from "./resource";

type Result<T> = Promise<{ data: Wire<T> | null; error: unknown }>;

/**
 * The part of a better-auth client (`createAuthClient({ plugins: [supportClient()] })`)
 * the hooks use. A real client assigns to it; tests pass a fake.
 */
export type SupportFetchClient = {
  support: {
    createTicket(input: {
      subject: string;
      body: string;
      organizationId?: string;
      visibility?: TicketVisibility;
    }): Result<CustomerTicketResponse>;
    myTickets(input?: {
      query?: {
        status?: TicketStatus;
        organizationId?: string;
        q?: string;
        cursor?: string;
      };
    }): Result<CustomerTicketListResponse>;
    ticket(input: {
      query: { id: string };
    }): Result<CustomerTicketDetailResponse>;
    reply(input: {
      ticketId: string;
      body: string;
      attachmentIds?: string[];
    }): Result<CustomerMessageResponse>;
    updateMine(input: {
      id: string;
      status?: "solved" | "open";
      visibility?: TicketVisibility;
      rating?: "good" | "bad";
    }): Result<CustomerTicketResponse>;
    markSeen(input: { id: string }): Result<OkResponse>;
    agent: {
      tickets(input?: {
        query?: {
          status?: TicketStatus;
          assignee?: string;
          tag?: string;
          organizationId?: string;
          q?: string;
          cursor?: string;
        };
      }): Result<AgentTicketListResponse>;
      ticket(input: {
        query: { id: string };
      }): Result<AgentTicketDetailResponse>;
      reply(input: {
        ticketId: string;
        body: string;
        internal?: boolean;
        status?: TicketStatus;
        mentions?: string[];
        attachmentIds?: string[];
      }): Result<AgentMessageResponse>;
      update(
        input: TicketUpdateInput & { ids: string[] },
      ): Result<UpdateTicketsResponse>;
      /** Optional: absent when merging is cut (`features.merge` false). */
      merge?(input: {
        sourceId: string;
        targetId: string;
      }): Result<AgentTicketResponse>;
      delete(input: { ids: string[] }): Result<DeleteTicketsResponse>;
      markSeen(input: { id: string }): Result<OkResponse>;
      tags(): Result<TagListResponse>;
      canned: ((input?: {
        query?: { q?: string };
      }) => Result<CannedReplyListResponse>) & {
        save(input: {
          id?: string;
          title: string;
          body: string;
        }): Result<CannedReplyResponse>;
        delete(input: { id: string }): Result<OkResponse>;
      };
    };
  };
  /**
   * Raw requests the typed methods can't make: uploads (POST with a `Blob`
   * body and the file's `content-type`) and attachment downloads (GET; the
   * response body arrives as a `Blob` because files are served as images,
   * PDF or `application/octet-stream`). Goes through the auth client, so
   * credentials and `baseURL` apply across origins.
   */
  $fetch: (
    path: string,
    options: {
      method: "GET" | "POST";
      query?: Record<string, string>;
      body?: Blob;
      headers?: Record<string, string>;
    },
  ) => Promise<{ data: unknown; error: unknown }>;
};

/** Fields agents can set on one or many tickets. `assigneeId: null` unassigns. */
export type TicketUpdateInput = {
  status?: TicketStatus;
  priority?: TicketPriority | null;
  assigneeId?: string | null;
  addTags?: string[];
  removeTags?: string[];
};

type Item<T> = T extends (infer U)[] ? U : never;
export type WireCustomerTicket = Wire<CustomerTicketResponse["ticket"]>;
export type WireCustomerMessage = Item<
  Wire<CustomerTicketDetailResponse["messages"]>
>;
export type WireCustomerAttachment = Item<
  Wire<CustomerTicketDetailResponse["attachments"]>
>;
export type WireAgentTicket = Wire<AgentTicketResponse["ticket"]>;
export type WireAgentMessage = Item<
  Wire<AgentTicketDetailResponse["messages"]>
>;
export type WireAgentAttachment = Item<
  Wire<AgentTicketDetailResponse["attachments"]>
>;
export type WireCannedReply = Wire<SupportCannedReplyRow>;
export type WireUploadedAttachment =
  | Wire<CustomerAttachmentResponse["attachment"]>
  | Wire<AgentAttachmentResponse["attachment"]>;

export type SupportPollingOptions = {
  /** Poll interval in ms, paused while the tab is hidden. 0 disables polling. @default 15000 */
  pollInterval?: number;
};

type Polling = SupportPollingOptions;

type AsyncState = {
  isLoading: boolean;
  error: unknown;
  refresh: () => Promise<void>;
};

export type UseSupportTicketsOptions = Polling & {
  status?: TicketStatus;
  organizationId?: string;
  q?: string;
};

export type UseSupportTicketsResult = AsyncState & {
  tickets: WireCustomerTicket[];
  /** From the server (`listMySupportTickets`). */
  features: { attachments: boolean };
  hasMore: boolean;
  loadMore: () => Promise<void>;
  /** Creates a ticket and refreshes the list. Null on error (see `error`). */
  createTicket: (input: {
    subject: string;
    body: string;
    organizationId?: string;
    visibility?: TicketVisibility;
  }) => Promise<WireCustomerTicket | null>;
};

/** The customer's ticket list (own + org-shared). */
export function useSupportTickets(
  client: SupportFetchClient,
  options: UseSupportTicketsOptions = {},
): UseSupportTicketsResult {
  const {
    status,
    organizationId,
    q,
    pollInterval = DEFAULT_POLL_INTERVAL,
  } = options;
  const clientRef = useRef(client);
  clientRef.current = client;

  const query = { status, organizationId, q };
  const list = useSupportPagedResource<
    WireCustomerTicket,
    { attachments: boolean }
  >({
    scope: `${status ?? ""}|${organizationId ?? ""}|${q ?? ""}`,
    pollInterval,
    fetchFirst: async () => {
      const res = await unwrap(
        clientRef.current.support.myTickets({ query: compact(query) }),
      );
      return {
        rows: res.tickets,
        nextCursor: res.nextCursor,
        extra: res.features,
      };
    },
    fetchMore: async (cursor) => {
      const res = await unwrap(
        clientRef.current.support.myTickets({
          query: { ...compact(query), cursor },
        }),
      );
      return { rows: res.tickets, nextCursor: res.nextCursor };
    },
  });
  const { refresh, fail } = list;

  const createTicket = useCallback(
    async (input: Parameters<UseSupportTicketsResult["createTicket"]>[0]) => {
      const done = await attempt(
        () => unwrap(clientRef.current.support.createTicket(input)),
        fail,
      );
      if (!done.ok) return null;
      await refresh();
      return done.value.ticket;
    },
    [refresh, fail],
  );

  return {
    tickets: list.rows,
    features: list.extra ?? { attachments: false },
    hasMore: list.hasMore,
    isLoading: list.isLoading,
    error: list.error,
    refresh,
    loadMore: list.loadMore,
    createTicket,
  };
}

export type UseSupportTicketResult = AsyncState & {
  ticket: WireCustomerTicket | null;
  messages: WireCustomerMessage[];
  attachments: WireCustomerAttachment[];
  /** True on success; refreshes the thread. */
  reply: (input: {
    body: string;
    attachmentIds?: string[];
  }) => Promise<boolean>;
  /** Requester only: solve/reopen, visibility, rating. */
  update: (input: {
    status?: "solved" | "open";
    visibility?: TicketVisibility;
    rating?: "good" | "bad";
  }) => Promise<boolean>;
  markSeen: () => Promise<void>;
  /**
   * Downloads one of this ticket's attachments through
   * `GET /support/attachment?id=` (`client.$fetch`). Resolves the file as a
   * `Blob` (show it with `URL.createObjectURL`, revoke when done), or null on
   * error (see `error`).
   */
  openAttachment: (id: string) => Promise<Blob | null>;
};

/**
 * One ticket as the customer sees it. `ticketId` null: idle. The server
 * follows merges, so `ticket.id` can differ from `ticketId`; actions then use
 * `ticket.id`.
 */
export function useSupportTicket(
  client: SupportFetchClient,
  ticketId: string | null,
  options: Polling = {},
): UseSupportTicketResult {
  const { pollInterval = DEFAULT_POLL_INTERVAL } = options;
  const clientRef = useRef(client);
  clientRef.current = client;

  const detail = useSupportResource({
    scope: ticketId ?? "",
    enabled: ticketId !== null,
    pollInterval,
    load: () =>
      unwrap(
        clientRef.current.support.ticket({
          query: { id: ticketId as string },
        }),
      ),
  });
  const { data, refresh, fail } = detail;

  // after a merge the server answers with the target; act on that one
  const actingId = data?.ticket.id ?? ticketId;

  const reply = useCallback(
    async (input: { body: string; attachmentIds?: string[] }) => {
      if (actingId === null) return false;
      const done = await attempt(
        () =>
          unwrap(
            clientRef.current.support.reply({ ticketId: actingId, ...input }),
          ),
        fail,
      );
      if (done.ok) await refresh();
      return done.ok;
    },
    [actingId, refresh, fail],
  );

  const update = useCallback(
    async (input: Parameters<UseSupportTicketResult["update"]>[0]) => {
      if (actingId === null) return false;
      const done = await attempt(
        () =>
          unwrap(
            clientRef.current.support.updateMine({ id: actingId, ...input }),
          ),
        fail,
      );
      if (done.ok) await refresh();
      return done.ok;
    },
    [actingId, refresh, fail],
  );

  const markSeen = useCallback(async () => {
    if (actingId === null) return;
    const done = await attempt(
      () => unwrap(clientRef.current.support.markSeen({ id: actingId })),
      fail,
    );
    if (done.ok) await refresh();
  }, [actingId, refresh, fail]);

  const openAttachment = useCallback(
    (id: string) =>
      downloadAttachment(clientRef.current, "/support/attachment", id, fail),
    [fail],
  );

  return {
    ticket: data?.ticket ?? null,
    messages: data?.messages ?? [],
    attachments: data?.attachments ?? [],
    isLoading: detail.isLoading,
    error: detail.error,
    refresh,
    reply,
    update,
    markSeen,
    openAttachment,
  };
}

export type UseSupportQueueOptions = Polling & {
  status?: TicketStatus;
  /** A user id, `"me"` or `"none"`. */
  assignee?: string;
  tag?: string;
  organizationId?: string;
  q?: string;
};

export type UseSupportQueueResult = AsyncState & {
  tickets: WireAgentTicket[];
  counts: AgentCounts;
  /** From the server (`listSupportTickets`). */
  features: { attachments: boolean; merge: boolean };
  /** Every tag in use (`listSupportTags`). */
  tags: string[];
  hasMore: boolean;
  loadMore: () => Promise<void>;
  /** Bulk update; resolves the number updated, or null on error. */
  update: (ids: string[], input: TicketUpdateInput) => Promise<number | null>;
  /** Absent when merging is cut; check `features.merge` too. */
  merge?: (
    sourceId: string,
    targetId: string,
  ) => Promise<WireAgentTicket | null>;
  remove: (ids: string[]) => Promise<number | null>;
};

/** The agent queue with filters, counts, tags and bulk actions. */
export function useSupportQueue(
  client: SupportFetchClient,
  options: UseSupportQueueOptions = {},
): UseSupportQueueResult {
  const {
    status,
    assignee,
    tag,
    organizationId,
    q,
    pollInterval = DEFAULT_POLL_INTERVAL,
  } = options;
  const clientRef = useRef(client);
  clientRef.current = client;

  const query = { status, assignee, tag, organizationId, q };
  const list = useSupportPagedResource<
    WireAgentTicket,
    {
      counts: AgentCounts;
      features: { attachments: boolean; merge: boolean };
      tags: string[];
    }
  >({
    scope: [status, assignee, tag, organizationId, q]
      .map((part) => part ?? "")
      .join("|"),
    pollInterval,
    fetchFirst: async () => {
      const agent = clientRef.current.support.agent;
      const [res, tags] = await Promise.all([
        unwrap(agent.tickets({ query: compact(query) })),
        unwrap(agent.tags()),
      ]);
      return {
        rows: res.tickets,
        nextCursor: res.nextCursor,
        extra: { counts: res.counts, features: res.features, tags },
      };
    },
    fetchMore: async (cursor) => {
      const res = await unwrap(
        clientRef.current.support.agent.tickets({
          query: { ...compact(query), cursor },
        }),
      );
      return { rows: res.tickets, nextCursor: res.nextCursor };
    },
  });
  const { refresh, fail } = list;

  const update = useCallback(
    async (ids: string[], input: TicketUpdateInput) => {
      const done = await attempt(
        () => unwrap(clientRef.current.support.agent.update({ ...input, ids })),
        fail,
      );
      if (!done.ok) return null;
      await refresh();
      return done.value.updated;
    },
    [refresh, fail],
  );

  const remove = useCallback(
    async (ids: string[]) => {
      const done = await attempt(
        () => unwrap(clientRef.current.support.agent.delete({ ids })),
        fail,
      );
      if (!done.ok) return null;
      await refresh();
      return done.value.deleted;
    },
    [refresh, fail],
  );

  const mergeSupported = typeof client.support.agent.merge === "function";
  const merge = useCallback(
    async (sourceId: string, targetId: string) => {
      const mergeCall = clientRef.current.support.agent.merge;
      if (!mergeCall) return null;
      const done = await attempt(
        () => unwrap(mergeCall({ sourceId, targetId })),
        fail,
      );
      if (!done.ok) return null;
      await refresh();
      return done.value.ticket;
    },
    [refresh, fail],
  );

  const extra = list.extra;
  return {
    tickets: list.rows,
    counts: extra?.counts ?? { open: 0, pending: 0, unassigned: 0, mine: 0 },
    features: extra?.features ?? { attachments: false, merge: false },
    tags: extra?.tags ?? [],
    hasMore: list.hasMore,
    isLoading: list.isLoading,
    error: list.error,
    refresh,
    loadMore: list.loadMore,
    update,
    merge: mergeSupported ? merge : undefined,
    remove,
  };
}

export type UseSupportAgentTicketResult = AsyncState & {
  ticket: WireAgentTicket | null;
  messages: WireAgentMessage[];
  attachments: WireAgentAttachment[];
  reply: (input: {
    body: string;
    internal?: boolean;
    status?: TicketStatus;
    mentions?: string[];
    attachmentIds?: string[];
  }) => Promise<boolean>;
  update: (input: TicketUpdateInput) => Promise<boolean>;
  markSeen: () => Promise<void>;
  /**
   * Downloads an attachment through `GET /support/agent/attachment?id=`
   * (`client.$fetch`). Resolves a `Blob`, or null on error (see `error`).
   */
  openAttachment: (id: string) => Promise<Blob | null>;
};

/**
 * One ticket as an agent sees it. `ticketId` null: idle. The server follows
 * merges, so `ticket.id` can differ from `ticketId`; actions then use
 * `ticket.id`.
 */
export function useSupportAgentTicket(
  client: SupportFetchClient,
  ticketId: string | null,
  options: Polling = {},
): UseSupportAgentTicketResult {
  const { pollInterval = DEFAULT_POLL_INTERVAL } = options;
  const clientRef = useRef(client);
  clientRef.current = client;

  const detail = useSupportResource({
    scope: ticketId ?? "",
    enabled: ticketId !== null,
    pollInterval,
    load: () =>
      unwrap(
        clientRef.current.support.agent.ticket({
          query: { id: ticketId as string },
        }),
      ),
  });
  const { data, refresh, fail } = detail;

  // after a merge the server answers with the target; act on that one
  const actingId = data?.ticket.id ?? ticketId;

  const reply = useCallback(
    async (input: Parameters<UseSupportAgentTicketResult["reply"]>[0]) => {
      if (actingId === null) return false;
      const done = await attempt(
        () =>
          unwrap(
            clientRef.current.support.agent.reply({
              ticketId: actingId,
              ...input,
            }),
          ),
        fail,
      );
      if (done.ok) await refresh();
      return done.ok;
    },
    [actingId, refresh, fail],
  );

  const update = useCallback(
    async (input: TicketUpdateInput) => {
      if (actingId === null) return false;
      const done = await attempt(
        () =>
          unwrap(
            clientRef.current.support.agent.update({
              ...input,
              ids: [actingId],
            }),
          ),
        fail,
      );
      if (done.ok) await refresh();
      return done.ok;
    },
    [actingId, refresh, fail],
  );

  const markSeen = useCallback(async () => {
    if (actingId === null) return;
    const done = await attempt(
      () => unwrap(clientRef.current.support.agent.markSeen({ id: actingId })),
      fail,
    );
    if (done.ok) await refresh();
  }, [actingId, refresh, fail]);

  const openAttachment = useCallback(
    (id: string) =>
      downloadAttachment(
        clientRef.current,
        "/support/agent/attachment",
        id,
        fail,
      ),
    [fail],
  );

  return {
    ticket: data?.ticket ?? null,
    messages: data?.messages ?? [],
    attachments: data?.attachments ?? [],
    isLoading: detail.isLoading,
    error: detail.error,
    refresh,
    reply,
    update,
    markSeen,
    openAttachment,
  };
}

export type UseSupportCannedRepliesResult = AsyncState & {
  cannedReplies: WireCannedReply[];
  save: (input: {
    id?: string;
    title: string;
    body: string;
  }) => Promise<WireCannedReply | null>;
  remove: (id: string) => Promise<boolean>;
};

/** Canned replies (agents), optionally filtered by `q`. */
export function useSupportCannedReplies(
  client: SupportFetchClient,
  options: { q?: string } = {},
): UseSupportCannedRepliesResult {
  const { q } = options;
  const clientRef = useRef(client);
  clientRef.current = client;

  // canned replies change when an agent edits them, not on their own, so
  // there is no interval; `refresh` and every mutation reload them
  const list = useSupportResource({
    scope: q ?? "",
    pollInterval: 0,
    load: () =>
      unwrap(clientRef.current.support.agent.canned({ query: compact({ q }) })),
  });
  const { refresh, fail } = list;

  const save = useCallback(
    async (input: { id?: string; title: string; body: string }) => {
      const done = await attempt(
        () => unwrap(clientRef.current.support.agent.canned.save(input)),
        fail,
      );
      if (!done.ok) return null;
      await refresh();
      return done.value.cannedReply;
    },
    [refresh, fail],
  );

  const remove = useCallback(
    async (id: string) => {
      const done = await attempt(
        () => unwrap(clientRef.current.support.agent.canned.delete({ id })),
        fail,
      );
      if (done.ok) await refresh();
      return done.ok;
    },
    [refresh, fail],
  );

  return {
    cannedReplies: list.data ?? [],
    isLoading: list.isLoading,
    error: list.error,
    refresh,
    save,
    remove,
  };
}

export type UseSupportUploadOptions = {
  ticketId: string;
  /** Upload through the agent endpoint. @default false */
  agent?: boolean;
  /**
   * Agent uploads for an internal note. Must match the message kind (true
   * for a note, false for a reply); mismatches fail with
   * `ATTACHMENT_NOT_USABLE`. Call `reset()` when the reply/note toggle
   * changes. @default false
   */
  internal?: boolean;
};

export type UseSupportUploadResult = {
  /** Uploads one file (raw body, `Content-Type` = its type). Null on error. */
  upload: (
    file: Blob,
    filename?: string,
  ) => Promise<WireUploadedAttachment | null>;
  /** Uploaded and not yet sent, in order. Pass their ids as `attachmentIds`. */
  uploads: WireUploadedAttachment[];
  isUploading: boolean;
  error: unknown;
  /** Drop one from `uploads` (it is pruned server-side after 24 h). */
  remove: (id: string) => void;
  /** Clear `uploads`, e.g. after sending. */
  reset: () => void;
};

/** Attachment uploads for one ticket. */
export function useSupportUpload(
  client: SupportFetchClient,
  options: UseSupportUploadOptions,
): UseSupportUploadResult {
  const { ticketId, agent = false, internal = false } = options;
  const clientRef = useRef(client);
  clientRef.current = client;

  const [uploads, setUploads] = useState<WireUploadedAttachment[]>([]);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<unknown>(null);
  // `reset()` (and a ticket change) invalidates uploads still in flight
  const generationRef = useRef(0);

  useEffect(() => {
    // uploads belong to one ticket and endpoint
    void ticketId;
    void agent;
    generationRef.current++;
    setUploads([]);
    setError(null);
  }, [ticketId, agent]);

  const upload = useCallback(
    async (file: Blob, filename?: string) => {
      const generation = generationRef.current;
      const name =
        filename ?? (file instanceof File ? file.name : undefined) ?? "file";
      setPending((count) => count + 1);
      try {
        const res = await clientRef.current.$fetch(
          agent ? "/support/agent/upload" : "/support/upload",
          {
            method: "POST",
            query: {
              ticketId,
              filename: name,
              ...(agent ? { internal: String(internal) } : {}),
            },
            body: file,
            headers: {
              "content-type": file.type || "application/octet-stream",
            },
          },
        );
        if (res.error) throw res.error;
        const attachment = (res.data as { attachment?: WireUploadedAttachment })
          ?.attachment;
        if (!attachment) {
          throw new Error("Empty response from the support endpoint");
        }
        if (generation === generationRef.current) {
          setUploads((prev) => [...prev, attachment]);
          setError(null);
        }
        return attachment;
      } catch (reason) {
        if (generation === generationRef.current) setError(() => reason);
        return null;
      } finally {
        setPending((count) => count - 1);
      }
    },
    [ticketId, agent, internal],
  );

  const remove = useCallback((id: string) => {
    setUploads((prev) => prev.filter((attachment) => attachment.id !== id));
  }, []);

  const reset = useCallback(() => {
    generationRef.current++;
    setUploads([]);
    setError(null);
  }, []);

  return {
    upload,
    uploads,
    isUploading: pending > 0,
    error,
    remove,
    reset,
  };
}

/**
 * GET `path?id=` through the auth client. A `Blob` comes back as is, any
 * other body is wrapped; null (and `fail`) on error.
 */
/** @internal Not exported from the package: the components preview images with it. */
export async function downloadAttachment(
  client: SupportFetchClient,
  path: string,
  id: string,
  fail: (reason: unknown) => void,
): Promise<Blob | null> {
  const done = await attempt(async () => {
    const res = await client.$fetch(path, { method: "GET", query: { id } });
    if (res.error) throw res.error;
    if (res.data === null || res.data === undefined) {
      throw new Error("Empty response from the support endpoint");
    }
    return res.data instanceof Blob
      ? res.data
      : new Blob([res.data as BlobPart]);
  }, fail);
  return done.ok ? done.value : null;
}
