import type { Block } from "./block";
import { Aggregate } from "./aggregate";
import { CompareDatasets } from "./compare-datasets";
import { Crypto } from "./crypto";
import { DateTime } from "./datetime";
import { Filter } from "./filter";
import { Jwt } from "./jwt";
import { Limit } from "./limit";
import { ManualTrigger } from "./manual";
import { NoOp } from "./noop";
import { RemoveDuplicates } from "./remove-duplicates";
import { RenameKeys } from "./rename-keys";
import { RespondToWebhook } from "./respond-to-webhook";
import { SetFields } from "./set";
import { Sort } from "./sort";
import { SplitOut } from "./split-out";
import { StopAndError } from "./stop-and-error";
import { Summarize } from "./summarize";
import { Switch } from "./switch";
import { Atlassian } from "./atlassian";
import { Telegram } from "./telegram";
import { TelegramTrigger } from "./telegram-trigger";
import { Wait } from "./wait";
import { Webhook } from "./webhook";
import { Branch } from "./branch";
import { CodeBlock } from "./code";
import { ActivationTrigger, WorkflowTrigger } from "./lifecycle-triggers";
import { ErrorTrigger } from "./error-trigger";
import { Every } from "./every";
import { Files } from "./files";
import { LocalFileTrigger } from "./local-file-trigger";
import { Shell } from "./shell";
import { Notification } from "./notify";
import { HttpRequest } from "./http-request";
import { Merge } from "./merge";
import { ResultBlock } from "./result";
import { Source } from "./source";
import { Transform } from "./transform";
import { GroupFrame, StickyNote } from "./layout";
import { CallTrigger, RunFlow } from "./flow-call";
import { Counter } from "./counter";
import { Log } from "./log";
import { Loop, LoopBreak } from "./loop";
import { CodeAgent } from "./code-agent";
import { MemoryBank } from "./memory";
import { CalculatorTool, CodeTool, DateTimeTool, RandomTool } from "./tools";

export type BlockClass = (new () => Block) & typeof Block;

export const registry: Record<string, BlockClass> = {
  // триггеры
  manual: ManualTrigger,
  every: Every,
  webhook: Webhook,
  telegram_trigger: TelegramTrigger,
  local_file_trigger: LocalFileTrigger,
  error_trigger: ErrorTrigger,
  workflow_trigger: WorkflowTrigger,
  activation_trigger: ActivationTrigger,
  call_trigger: CallTrigger,
  // ввод / вывод
  source: Source,
  http_request: HttpRequest,
  respond_to_webhook: RespondToWebhook,
  files: Files,
  shell: Shell,
  notify: Notification,
  log: Log,
  result: ResultBlock,
  // приложения
  telegram: Telegram,
  atlassian: Atlassian,
  // данные
  transform: Transform,
  set: SetFields,
  filter: Filter,
  sort: Sort,
  limit: Limit,
  remove_duplicates: RemoveDuplicates,
  aggregate: Aggregate,
  split_out: SplitOut,
  summarize: Summarize,
  rename_keys: RenameKeys,
  datetime: DateTime,
  counter: Counter,
  crypto: Crypto,
  jwt: Jwt,
  code: CodeBlock,
  code_agent: CodeAgent,
  // оформление: заметки и группы (не участвуют в запуске)
  note: StickyNote,
  group: GroupFrame,
  // ресурсы: подключаются к ресурсным портам нод (инструменты, память)
  tool_datetime: DateTimeTool,
  tool_calculator: CalculatorTool,
  tool_random: RandomTool,
  tool_code: CodeTool,
  memory_bank: MemoryBank,
  // логика
  branch: Branch,
  switch: Switch,
  merge: Merge,
  compare_datasets: CompareDatasets,
  wait: Wait,
  stop_and_error: StopAndError,
  run_flow: RunFlow,
  loop: Loop,
  loop_break: LoopBreak,
  noop: NoOp,
};
