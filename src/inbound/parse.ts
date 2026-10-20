// BYO_STUB: final owner N11a. Signature and output type are final (contracts.md); body is neutral.
// Loads the MIME parser with a dynamic import() only, so the root entry stays light.
import type { SupportInboundPart } from "../options";

export type ParsedAddress = { address: string; name: string | null };

/** What support needs from a raw RFC 822 message. Addresses are lowercased. */
export type ParsedMessage = {
  /** `Message-ID` with angle brackets, as sent; null when missing. */
  messageId: string | null;
  from: ParsedAddress | null;
  /** `To`, `Cc` and `Delivered-To`/`X-Original-To` recipients, lowercased, deduped. */
  recipients: string[];
  subject: string;
  /** The text body with the quoted reply stripped (HTML converted to text when there is no text part). */
  text: string;
  inReplyTo: string | null;
  references: string[];
  /** `Return-Path` address; `""` for the null path `<>`; null when absent. */
  returnPath: string | null;
  /** Header names lowercased; repeated headers joined with ", ". */
  headers: Record<string, string>;
  attachments: SupportInboundPart[];
};

/** Parses a raw message (`postal-mime`, loaded by dynamic `import()`). Throws on unparseable input. */
export async function parseMessage(_raw: Uint8Array): Promise<ParsedMessage> {
  return {
    messageId: null,
    from: null,
    recipients: [],
    subject: "",
    text: "",
    inReplyTo: null,
    references: [],
    returnPath: null,
    headers: {},
    attachments: [],
  };
}
