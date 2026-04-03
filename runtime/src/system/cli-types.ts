/**
 * CLI 类型定义 — IO 接口抽象（ADR-235 FP 改进）。
 *
 * 将命令逻辑与 IO 实现解耦，使命令处理可单元测试。
 *
 * @see docs/adr/235-cli-human-readable-output.md
 */

// ── Engine Client 接口 ──

/** Engine API 客户端接口。 */
export interface EngineClient {
  /** POST 请求，返回解析后的 JSON 或 null。 */
  post: (path: string, body: unknown) => Promise<unknown | null>;

  /** GET 请求，返回解析后的 JSON 或 null。 */
  get: (path: string) => Promise<unknown | null>;

  /** Query 端点专用 POST（自动解包 {ok, result}）。 */
  query: (path: string, body: unknown) => Promise<unknown | null>;
}

// ── Output 接口 ──

/** 输出接口。 */
export interface Output {
  /** 标准输出。 */
  log: (msg: string) => void;

  /** 标准错误。 */
  error: (msg: string) => void;

  /** 退出进程。 */
  exit: (code: number) => never;
}

// ── Target Resolver 接口 ──

/** 解析目标聊天 ID（返回 number 供 Engine API 使用）。 */
export type TargetResolver = (target: string | undefined) => Promise<number>;

// ── Command Context ──

/** 命令执行上下文 — 包含所有 IO 依赖。 */
export interface CliContext {
  engine: EngineClient;
  output: Output;
  resolveTarget: TargetResolver;
}

// ── Result Types ──

/** 发送消息结果。 */
export interface SendResult {
  msgId?: number;
}

/** 下载结果。 */
export interface DownloadResult {
  path?: string;
  mime?: string;
  size?: number;
}

/** 转发结果。 */
export interface ForwardResult {
  forwardedMsgId?: number;
  commentMsgId?: number;
}

// ── Error Formatting ──

/** 格式化 CLI 错误（纯函数）。 */
export function formatCliError(cliName: string, msg: string): string {
  return `✗ ${cliName}: ${msg}`;
}

/** 构造错误退出函数（闭包）。 */
export function makeDie(output: Output, cliName: string): (msg: string) => never {
  return (msg: string): never => {
    output.error(formatCliError(cliName, msg));
    output.exit(1);
  };
}

// ── Re-export Command Args Types ──

// 这些类型在 cli-commands.ts 中定义，这里 re-export 方便使用
export type {
  CommandResult,
  JoinArgs,
  LeaveArgs,
  MotdArgs,
  ReactArgs,
  ReadArgs,
  ReplyArgs,
  SayArgs,
  StickerArgs,
  TailArgs,
  ThreadsArgs,
  VoiceArgs,
  WhoisArgs,
} from "./cli-commands.js";
