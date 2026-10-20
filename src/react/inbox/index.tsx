// BYO_STUB: final owner N12c. Props are final (contracts.md); renders nothing yet.
import type { ReactNode } from "react";
import type { SupportFetchClient, WireAgentMessage } from "../hooks";
import type { SupportLabels } from "../labels";
import type { SupportInboxLabels } from "./labels";

/** A staff member for the assignee and @mention pickers (the plugin doesn't enumerate staff). */
export type SupportAgent = { id: string; name: string; image?: string | null };

export type SupportInboxProps = {
  client: SupportFetchClient;
  agents: SupportAgent[];
  /** Called with in-app links; route with your router. Default: `location.assign`. */
  onNavigate?: (href: string) => void;
  /** Render one message; `fallback` is the default rendering. */
  renderMessage?: (message: WireAgentMessage, fallback: ReactNode) => ReactNode;
  /** Poll interval in ms. @default 15000 */
  pollInterval?: number;
  /** Shared keys (`SupportLabels`) plus this component's own. */
  labels?: Partial<SupportLabels & SupportInboxLabels>;
  className?: string;
  queueClassName?: string;
  threadClassName?: string;
  messageClassName?: string;
  composerClassName?: string;
  buttonClassName?: string;
};

/**
 * The agent inbox: queue with filters, thread, reply/note toggle, canned
 * replies, @mentions, attachments, status/priority/assignee/tags, bulk
 * update, merge and delete (attachment and merge UI hidden when their
 * `features` flag is false).
 */
export function SupportInbox(_props: SupportInboxProps): ReactNode {
  return null;
}
