// BYO_STUB: final owner N12a. Signatures and types are final (contracts.md); bodies return empty state.
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
      merge(input: {
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
  /** Used for raw-body uploads (`/support/upload`, `/support/agent/upload`). */
  $fetch: (
    path: string,
    options: {
      method: "POST";
      query: Record<string, string>;
      body: Blob;
      headers: Record<string, string>;
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

type Polling = {
  /** Poll interval in ms, paused while the tab is hidden. 0 disables polling. @default 15000 */
  pollInterval?: number;
};

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
  _client: SupportFetchClient,
  _options: UseSupportTicketsOptions = {},
): UseSupportTicketsResult {
  return {
    tickets: [],
    features: { attachments: false },
    hasMore: false,
    isLoading: false,
    error: null,
    refresh: async () => {},
    loadMore: async () => {},
    createTicket: async () => null,
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
};

/** One ticket as the customer sees it. `ticketId` null: idle. */
export function useSupportTicket(
  _client: SupportFetchClient,
  _ticketId: string | null,
  _options: Polling = {},
): UseSupportTicketResult {
  return {
    ticket: null,
    messages: [],
    attachments: [],
    isLoading: false,
    error: null,
    refresh: async () => {},
    reply: async () => false,
    update: async () => false,
    markSeen: async () => {},
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
  merge: (
    sourceId: string,
    targetId: string,
  ) => Promise<WireAgentTicket | null>;
  remove: (ids: string[]) => Promise<number | null>;
};

/** The agent queue with filters, counts, tags and bulk actions. */
export function useSupportQueue(
  _client: SupportFetchClient,
  _options: UseSupportQueueOptions = {},
): UseSupportQueueResult {
  return {
    tickets: [],
    counts: { open: 0, pending: 0, unassigned: 0, mine: 0 },
    features: { attachments: false, merge: false },
    tags: [],
    hasMore: false,
    isLoading: false,
    error: null,
    refresh: async () => {},
    loadMore: async () => {},
    update: async () => null,
    merge: async () => null,
    remove: async () => null,
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
};

/** One ticket as an agent sees it. `ticketId` null: idle. */
export function useSupportAgentTicket(
  _client: SupportFetchClient,
  _ticketId: string | null,
  _options: Polling = {},
): UseSupportAgentTicketResult {
  return {
    ticket: null,
    messages: [],
    attachments: [],
    isLoading: false,
    error: null,
    refresh: async () => {},
    reply: async () => false,
    update: async () => false,
    markSeen: async () => {},
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
  _client: SupportFetchClient,
  _options: { q?: string } = {},
): UseSupportCannedRepliesResult {
  return {
    cannedReplies: [],
    isLoading: false,
    error: null,
    refresh: async () => {},
    save: async () => null,
    remove: async () => false,
  };
}

export type UseSupportUploadOptions = {
  ticketId: string;
  /** Upload through the agent endpoint. @default false */
  agent?: boolean;
  /** Agent uploads for an internal note. @default false */
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
  _client: SupportFetchClient,
  _options: UseSupportUploadOptions,
): UseSupportUploadResult {
  return {
    upload: async () => null,
    uploads: [],
    isUploading: false,
    error: null,
    remove: () => {},
    reset: () => {},
  };
}
