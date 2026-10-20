// BYO_STUB: final owner N12b. Props are final (contracts.md); renders nothing yet.
import type { ReactNode } from "react";
import type { SupportFetchClient, WireCustomerMessage } from "../hooks";
import type { SupportLabels } from "../labels";
import type { SupportWidgetLabels } from "./labels";

export type SupportWidgetProps = {
  client: SupportFetchClient;
  /** Called with in-app links; route with your router. Default: `location.assign`. */
  onNavigate?: (href: string) => void;
  /** Render one message; `fallback` is the default rendering. */
  renderMessage?: (
    message: WireCustomerMessage,
    fallback: ReactNode,
  ) => ReactNode;
  /** Organization for new tickets and "share with my organization". */
  organizationId?: string;
  /** Poll interval in ms. @default 15000 */
  pollInterval?: number;
  /** Shared keys (`SupportLabels`) plus this component's own. */
  labels?: Partial<SupportLabels & SupportWidgetLabels>;
  className?: string;
  listClassName?: string;
  threadClassName?: string;
  messageClassName?: string;
  composerClassName?: string;
  buttonClassName?: string;
};

/**
 * The customer widget: ticket list, new ticket, thread, reply with
 * attachments (hidden when `features.attachments` is false), solve/reopen,
 * rate, share with the organization.
 */
export function SupportWidget(_props: SupportWidgetProps): ReactNode {
  return null;
}
