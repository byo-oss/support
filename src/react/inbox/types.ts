import type { SupportLabels } from "../labels";
import type { SupportInboxLabels } from "./labels";

/** A staff member for the assignee and @mention pickers (the plugin doesn't enumerate staff). */
export type SupportAgent = { id: string; name: string; image?: string | null };

/** Every label the inbox uses, defaults filled in. */
export type InboxLabels = SupportLabels & SupportInboxLabels;

/** The class props a part takes from the app. */
export type InboxClasses = {
  buttonClassName?: string | undefined;
};
