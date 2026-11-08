import type { Json, ParamSchema } from "@fl0w/schema";
import { Block, triggerPayload, type MailWatchSpec, type RunContext } from "./block";
import { assertRelativePath } from "./sandbox";
import { MAIL_PROVIDERS } from "./mail";
import { resolveSecret } from "./secrets";

const MIN_INTERVAL = 15;
const MAX_INTERVAL = 3600;
const on = (param: string, ...values: string[]) => ({ param, in: values });

/**
 * Mail Trigger: fires on every new message in a mailbox (analogue of Email Trigger (IMAP) and Microsoft Outlook Trigger from n8n).
 * Works for a published flow: the server polls the mailbox (`intervalSec`, at most once per 15 s) through the same provider driver as
 * the Mail block: IMAP (any server) or Microsoft Graph. One run per message; the output is the whole message, as in Mail -> getMail:
 * `{ id, from, to, cc, subject, date, unread, text, html, attachments, folder }` (with `saveAttachments` attachments have a `path`).
 *
 * `action: markRead`: mark the message read after the run (so it does not fire again after a server restart);
 * `none`: leave it alone (a repeat after a restart is ruled out because messages already in the mailbox are skipped in this mode).
 * `processExisting`: also process messages already in the mailbox at publish time. The "already seen" state lives in server memory.
 */
export class MailTrigger extends Block {
  static type = "mail_trigger";
  static label = "Mail Trigger";
  static icon = "mail-plus";
  static category = "trigger";
  static isTrigger = true;
  static autoTrigger = true;
  static eventDriven = true;
  static ports = { inputs: [], outputs: [{ id: "out0" }] };
  static params: ParamSchema[] = [
    { name: "provider", type: "enum", default: "imap", options: MAIL_PROVIDERS.map((value) => ({ value })) },
    { name: "host", type: "string", expressions: false, showWhen: on("provider", "imap") },
    { name: "port", type: "number", default: 993, min: 1, max: 65535, showWhen: on("provider", "imap") },
    { name: "secure", type: "boolean", default: true, showWhen: on("provider", "imap") },
    { name: "tlsInsecure", type: "boolean", default: false, showWhen: on("provider", "imap") },
    { name: "tenantId", type: "string", expressions: false, showWhen: on("provider", "graph") },
    { name: "clientId", type: "string", expressions: false, showWhen: on("provider", "graph") },
    { name: "username", type: "string", required: true, expressions: false },
    { name: "password", type: "string", required: true, expressions: false },
    { name: "folder", type: "string", default: "INBOX" },
    { name: "unreadOnly", type: "boolean", default: true },
    { name: "fromFilter", type: "string", default: "" },
    { name: "subjectFilter", type: "string", default: "" },
    { name: "intervalSec", type: "number", default: 60, min: MIN_INTERVAL, max: MAX_INTERVAL },
    { name: "action", type: "enum", default: "markRead", options: [{ value: "markRead" }, { value: "none" }] },
    { name: "processExisting", type: "boolean", default: false },
    { name: "saveAttachments", type: "boolean", default: false },
    { name: "attachmentsDir", type: "string", default: "mail", expressions: false, showWhen: on("saveAttachments", "true") },
  ];

  static mailWatch(params: Record<string, Json>): MailWatchSpec {
    const str = (k: string) => (typeof params[k] === "string" ? (params[k] as string).trim() : "");
    const provider = str("provider") || "imap";
    if (!(MAIL_PROVIDERS as readonly string[]).includes(provider)) throw new Error(`Unknown provider "${provider}"`);
    const username = str("username");
    if (username === "") throw new Error('Mail Trigger: "username" is required');
    if (provider === "imap" && str("host") === "") throw new Error('Mail Trigger: "host" (IMAP server) is required');
    if (provider === "graph" && (str("tenantId") === "" || str("clientId") === "")) throw new Error('Mail Trigger: "tenantId" and "clientId" are required for Microsoft Graph');
    const intervalSec = Math.trunc(Number(params["intervalSec"] ?? 60));
    if (!Number.isFinite(intervalSec) || intervalSec < MIN_INTERVAL || intervalSec > MAX_INTERVAL) throw new Error(`Mail Trigger: "intervalSec" must be ${MIN_INTERVAL}…${MAX_INTERVAL}`);
    const action = str("action") || "markRead";
    if (action !== "markRead" && action !== "none") throw new Error(`Unknown action "${action}"`);
    const attachmentsDir = str("attachmentsDir") || "mail";
    assertRelativePath(attachmentsDir);
    const { provider: _p, ...rest } = params;
    return {
      connection: { ...rest, provider },
      username,
      password: resolveSecret(str("password"), undefined),
      folder: str("folder") || "INBOX",
      unreadOnly: params["unreadOnly"] !== false,
      fromFilter: str("fromFilter"),
      subjectFilter: str("subjectFilter"),
      intervalSec,
      action,
      saveAttachments: params["saveAttachments"] === true,
      attachmentsDir,
      processExisting: params["processExisting"] === true,
    };
  }

  async run(_inputs: Record<string, Json>, _params: Record<string, Json>, ctx: RunContext) {
    return { out0: triggerPayload(ctx, "Mail Trigger") };
  }
}
