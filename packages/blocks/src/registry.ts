import type { Block } from "./block";
import { Branch } from "./branch";
import { CodeBlock } from "./code";
import { Every } from "./every";
import { HttpRequest } from "./http-request";
import { Merge } from "./merge";
import { ResultBlock } from "./result";
import { Source } from "./source";
import { Transform } from "./transform";

export type BlockClass = (new () => Block) & typeof Block;

export const registry: Record<string, BlockClass> = {
  every: Every,
  source: Source,
  transform: Transform,
  branch: Branch,
  merge: Merge,
  http_request: HttpRequest,
  code: CodeBlock,
  result: ResultBlock,
};
