import type { Json } from "@fl0w/schema";

/** Письмо в списке: коротко, без тела. */
export type MailItem = { id: string; from: string; to: string[]; subject: string; date: string | null; unread: boolean };

export type OutMail = { from?: string; to: string[]; cc: string[]; bcc: string[]; subject: string; body: string; html: boolean };

export type ListQuery = { folder: string; unreadOnly: boolean; from: string; subject: string; since: Date | null; limit: number };

/**
 * Что умеет любой почтовый провайдер. Блок Mail не знает, чем реализована почта (IMAP/SMTP, Microsoft Graph, …): новый
 * провайдер — новый драйвер с этим набором операций, блок и флоу не меняются.
 */
export interface MailDriver {
  send(mail: OutMail): Promise<Json>;
  list(q: ListQuery): Promise<MailItem[]>;
  /** Письмо целиком: заголовки, текст, html, список вложений (содержимое вложений не загружается). */
  get(folder: string, id: string): Promise<Json>;
  markRead(folder: string, id: string, read: boolean): Promise<Json>;
  close(): Promise<void>;
}

export const MAX_BODY_CHARS = 1_000_000;
export const MAX_LIST = 100;
