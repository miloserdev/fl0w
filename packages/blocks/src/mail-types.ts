import type { Json } from "@fl0w/schema";

/** A message in a list: brief, without the body. */
export type MailItem = { id: string; from: string; to: string[]; subject: string; date: string | null; unread: boolean };

export type OutMail = { from?: string; to: string[]; cc: string[]; bcc: string[]; subject: string; body: string; html: boolean };

export type ListQuery = { folder: string; unreadOnly: boolean; from: string; subject: string; since: Date | null; limit: number };

/**
 * What any mail provider can do. The Mail block does not know what implements the mail (IMAP/SMTP, Microsoft Graph, ...): a new
 * provider is a new driver with this set of operations, the block and flows do not change.
 */
/** An attachment with content: only for saving to disk; only metadata and the path go into the block result. */
export type MailAttachment = { filename: string; contentType: string; size: number; bytes: Uint8Array };

export interface MailDriver {
  send(mail: OutMail): Promise<Json>;
  list(q: ListQuery): Promise<MailItem[]>;
  /** A whole message: headers, text, html, list of attachments (attachment content is not loaded). */
  get(folder: string, id: string): Promise<Json>;
  markRead(folder: string, id: string, read: boolean): Promise<Json>;
  /** Reply to a message (to all senders and recipients with `all`). */
  reply(folder: string, id: string, body: string, html: boolean, all: boolean): Promise<Json>;
  /** Move a message to another folder (to the trash by moving, not deleting for good). */
  move(folder: string, id: string, destination: string): Promise<Json>;
  /** Attachments of a message with content (the total size limit is `MAX_ATTACHMENT_TOTAL`). */
  attachments(folder: string, id: string): Promise<MailAttachment[]>;
  close(): Promise<void>;
}

export const MAX_BODY_CHARS = 1_000_000;
export const MAX_LIST = 100;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL = 100 * 1024 * 1024;
export const MAX_ATTACHMENTS = 50;
