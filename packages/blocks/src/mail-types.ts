import type { Json } from "@fl0w/schema";

/** Письмо в списке: коротко, без тела. */
export type MailItem = { id: string; from: string; to: string[]; subject: string; date: string | null; unread: boolean };

export type OutMail = { from?: string; to: string[]; cc: string[]; bcc: string[]; subject: string; body: string; html: boolean };

export type ListQuery = { folder: string; unreadOnly: boolean; from: string; subject: string; since: Date | null; limit: number };

/**
 * Что умеет любой почтовый провайдер. Блок Mail не знает, чем реализована почта (IMAP/SMTP, Microsoft Graph, …): новый
 * провайдер — новый драйвер с этим набором операций, блок и флоу не меняются.
 */
/** Вложение с содержимым — только для сохранения на диск; в результат блока попадают лишь метаданные и путь. */
export type MailAttachment = { filename: string; contentType: string; size: number; bytes: Uint8Array };

export interface MailDriver {
  send(mail: OutMail): Promise<Json>;
  list(q: ListQuery): Promise<MailItem[]>;
  /** Письмо целиком: заголовки, текст, html, список вложений (содержимое вложений не загружается). */
  get(folder: string, id: string): Promise<Json>;
  markRead(folder: string, id: string, read: boolean): Promise<Json>;
  /** Ответить на письмо (всем отправителям и получателям — при `all`). */
  reply(folder: string, id: string, body: string, html: boolean, all: boolean): Promise<Json>;
  /** Переместить письмо в другую папку (в корзину — перемещением, не удалением насовсем). */
  move(folder: string, id: string, destination: string): Promise<Json>;
  /** Вложения письма с содержимым (общий предел размера — `MAX_ATTACHMENT_TOTAL`). */
  attachments(folder: string, id: string): Promise<MailAttachment[]>;
  close(): Promise<void>;
}

export const MAX_BODY_CHARS = 1_000_000;
export const MAX_LIST = 100;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL = 100 * 1024 * 1024;
export const MAX_ATTACHMENTS = 50;
