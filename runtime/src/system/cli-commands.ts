/**
 * IRC 命令逻辑 — 纯函数版本（ADR-239 GitHub CLI 风格）。
 *
 * ADR-239 变更：
 * - --json 接受逗号分隔字段列表（非 boolean）
 * - 命令返回 rawResult 供字段过滤
 * - 输出格式化由 makeRunner 统一处理
 *
 * @see docs/adr/239-gh-cli-style-output-pipeline.md
 */

import { renderConfirm, renderHuman, truncate } from "./cli-bridge.js";
import { type CliContext, makeDie, type SendResult } from "./cli-types.js";

const ACTION_PREFIX = "__ALICE_ACTION__:";

// ── Command Result Types ──

/** 命令执行结果 — 包含所有待输出内容。 */
export interface CommandResult {
  /** action trace 行（如 `__ALICE_ACTION__:sent:chatId=xxx:msgId=yyy`）。 */
  action?: string;
  /** 主输出内容（人类可读文本）。 */
  output: string;
  /** 原始结果对象（用于 JSON 字段过滤）。 */
  rawResult?: unknown;
}

/** 命令处理器 — 接收上下文和参数，返回待输出结果。 */
export type CommandHandler<T = Record<string, unknown>> = (
  ctx: CliContext,
  args: T,
) => Promise<CommandResult>;

// ── Say Command ──

export interface SayArgs {
  json?: string;
  in?: string;
  text: string;
  "resolve-thread"?: string; // thread ID to resolve after sending (CLI flag format)
}

/** say 命令逻辑。 */
export async function sayCommand(ctx: CliContext, args: SayArgs): Promise<CommandResult> {
  const die = makeDie(ctx.output, "irc");

  const chatId = await ctx.resolveTarget(args.in);
  const text = args.text;

  if (!text.trim()) die("say requires non-empty text");

  const result = (await ctx.engine.post("/telegram/send", { chatId, text })) as SendResult | null;

  const action =
    result?.msgId != null
      ? `${ACTION_PREFIX}sent:chatId=${chatId}:msgId=${result.msgId}`
      : undefined;

  // ADR-240: resolve thread after sending message
  if (args["resolve-thread"]) {
    const threadId = Number(args["resolve-thread"]);
    if (!Number.isFinite(threadId) || threadId <= 0) {
      die("--resolve-thread requires a positive integer thread ID");
    }
    try {
      await ctx.engine.post("/dispatch/resolve_topic", { threadId });
    } catch (err) {
      // Don't fail the entire command if resolve fails
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[resolve-thread] Failed to resolve thread #${threadId}: ${errMsg}`);
    }
  }

  return {
    action,
    output: renderConfirm("Sent", `"${truncate(text)}"`),
    rawResult: { msgId: result?.msgId, chatId },
  };
}

// ── Reply Command ──

export interface ReplyArgs {
  json?: string;
  in?: string;
  msgId: string;
  text: string;
}

/** 解析消息 ID（纯函数）。 */
export function parseMsgId(raw: string): number {
  const n = Number(raw.replace(/^#/, ""));
  if (!Number.isFinite(n)) throw new Error(`invalid message ID: ${raw}`);
  return n;
}

/** reply 命令逻辑。 */
export async function replyCommand(ctx: CliContext, args: ReplyArgs): Promise<CommandResult> {
  const die = makeDie(ctx.output, "irc");

  const chatId = await ctx.resolveTarget(args.in);
  const replyTo = parseMsgId(args.msgId);
  const text = args.text;

  if (!text.trim()) die("reply requires non-empty text");

  const result = (await ctx.engine.post("/telegram/send", {
    chatId,
    text,
    replyTo,
  })) as SendResult | null;

  const action =
    result?.msgId != null
      ? `${ACTION_PREFIX}sent:chatId=${chatId}:msgId=${result.msgId}`
      : undefined;

  return {
    action,
    output: renderConfirm("Replied to", `#${replyTo}: "${truncate(text)}"`),
    rawResult: { msgId: result?.msgId, chatId, replyTo },
  };
}

// ── React Command ──

export interface ReactArgs {
  json?: string;
  in?: string;
  msgId: string;
  emoji: string;
}

/** react 命令逻辑。 */
export async function reactCommand(ctx: CliContext, args: ReactArgs): Promise<CommandResult> {
  const die = makeDie(ctx.output, "irc");

  const chatId = await ctx.resolveTarget(args.in);
  const msgId = parseMsgId(args.msgId);
  const emoji = args.emoji;

  const result = await ctx.engine.post("/telegram/react", { chatId, msgId, emoji });

  return {
    output: renderConfirm(`Reacted ${emoji} to`, `#${msgId}`),
    rawResult: { success: true, chatId, msgId },
  };
}

// ── Sticker Command ──

export interface StickerArgs {
  json?: string;
  in?: string;
  keyword: string;
}

/** sticker 命令逻辑。 */
export async function stickerCommand(ctx: CliContext, args: StickerArgs): Promise<CommandResult> {
  const die = makeDie(ctx.output, "irc");

  const chatId = await ctx.resolveTarget(args.in);
  const keyword = args.keyword;

  const result = (await ctx.engine.post("/telegram/sticker", {
    chatId,
    sticker: keyword,
  })) as SendResult | null;

  const action =
    result?.msgId != null
      ? `${ACTION_PREFIX}sticker:chatId=${chatId}:msgId=${result.msgId}`
      : undefined;

  return {
    action,
    output: renderConfirm("Sent sticker", keyword),
    rawResult: { msgId: result?.msgId, chatId },
  };
}

// ── Voice Command ──

export interface VoiceArgs {
  json?: string;
  in?: string;
  emotion?: string;
  ref?: string;
  text: string;
}

/** voice 命令逻辑。 */
export async function voiceCommand(ctx: CliContext, args: VoiceArgs): Promise<CommandResult> {
  const die = makeDie(ctx.output, "irc");

  const chatId = await ctx.resolveTarget(args.in);
  const text = args.text.trim();

  if (!text) die("voice requires non-empty text");

  const body: Record<string, unknown> = { chatId, text };
  if (args.emotion) body.emotion = args.emotion;
  if (args.ref) body.replyTo = parseMsgId(args.ref);

  const result = (await ctx.engine.post("/telegram/voice", body)) as SendResult | null;

  const action =
    result?.msgId != null
      ? `${ACTION_PREFIX}voice:chatId=${chatId}:msgId=${result.msgId}`
      : undefined;

  return {
    action,
    output: renderConfirm("Sent voice", `"${truncate(text)}"`),
    rawResult: { msgId: result?.msgId, chatId },
  };
}

// ── Read Command ──

export interface ReadArgs {
  json?: string;
  in?: string;
}

/** read 命令逻辑。 */
export async function readCommand(ctx: CliContext, args: ReadArgs): Promise<CommandResult> {
  const die = makeDie(ctx.output, "irc");

  const chatId = await ctx.resolveTarget(args.in);
  await ctx.engine.post("/telegram/read", { chatId });

  return {
    output: renderConfirm("Marked as read"),
    rawResult: { success: true },
  };
}

// ── Tail Command ──

export interface TailArgs {
  json?: string;
  in?: string;
  count: string;
}

/** tail 命令逻辑。 */
export async function tailCommand(ctx: CliContext, args: TailArgs): Promise<CommandResult> {
  const die = makeDie(ctx.output, "irc");

  const chatId = await ctx.resolveTarget(args.in);
  const count = Number(args.count);

  if (!Number.isFinite(count)) die("tail count must be a number");

  const result = await ctx.engine.get(`/chat/${chatId}/tail?limit=${count}`);

  // 标注来源（用于远程聊天）
  const isRemote = args.in != null;
  const header = isRemote ? `[tail @${chatId}]\n` : "";

  const messages = Array.isArray(result) ? result : [];
  if (messages.length === 0) {
    return { output: header + "(no messages)", rawResult: [] };
  }

  const lines: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as { sender?: string; text?: string; id?: number; timestamp?: string };
    const sender = m.sender ?? "?";
    const text = m.text ?? "";
    const prefix = m.id != null ? `(#${m.id}) ` : "";
    lines.push(`${i + 1}. ${prefix}${sender}: "${truncate(text, 80)}"`);
  }

  return {
    output: header + lines.join("\n"),
    rawResult: messages,
  };
}

// ── Whois Command ──

export interface WhoisArgs {
  json?: string;
  in?: string;
  /** citty 可能返回 string 或 string[]（即使 multiple: true） */
  target?: string | string[];
}

/** 从 graph 属性响应中提取 value（纯函数）。 */
export function gval(res: unknown): unknown {
  return (res as { value?: unknown } | null)?.value ?? null;
}

/** whois 命令逻辑。 */
export async function whoisCommand(ctx: CliContext, args: WhoisArgs): Promise<CommandResult> {
  // 合并含空格的名称（defensive: citty 可能返回 string 或 string[]）
  const targets = args.target;
  const target =
    typeof targets === "string"
      ? targets.trim() || undefined
      : Array.isArray(targets) && targets.length
        ? targets.join(" ").trim()
        : undefined;

  if (target) {
    // whois NAME/@ID → 联系人画像
    const stripped = target.startsWith("@") || target.startsWith("~") ? target.slice(1) : target;

    // 尝试解析为数字 ID
    const n = Number(stripped);
    let contactId: string;

    if (Number.isFinite(n)) {
      contactId = `contact:${n}`;
    } else {
      // 尝试名称解析
      const resolveResult = (await ctx.engine.post("/resolve/name", { name: target })) as {
        result?: { telegramId: number | null } | null;
      };
      if (resolveResult?.result?.telegramId != null) {
        contactId = `contact:${resolveResult.result.telegramId}`;
      } else {
        throw new Error(`contact not found: "${target}"`);
      }
    }

    const result = await ctx.engine.query("/query/contact_profile", { contactId });
    return { output: renderHuman(result), rawResult: result };
  }

  // whois（无参数）→ 聊天室信息
  const chatId = await ctx.resolveTarget(args.in);
  const [name, chatType, topic, unread, pendingDirected, aliceRole] = await Promise.all([
    ctx.engine.get(`/graph/channel:${chatId}/display_name`),
    ctx.engine.get(`/graph/channel:${chatId}/chat_type`),
    ctx.engine.get(`/graph/channel:${chatId}/topic`),
    ctx.engine.get(`/graph/channel:${chatId}/unread`),
    ctx.engine.get(`/graph/channel:${chatId}/pending_directed`),
    ctx.engine.get(`/graph/channel:${chatId}/alice_role`),
  ]);

  const data = {
    chatId,
    name: gval(name),
    chatType: gval(chatType),
    topic: gval(topic),
    unread: gval(unread) ?? 0,
    pendingDirected: gval(pendingDirected) ?? 0,
    role: gval(aliceRole),
  };

  const lines = [
    `Channel: ${data.name ?? chatId}`,
    data.chatType ? `Type: ${data.chatType}` : null,
    data.topic ? `Topic: "${data.topic}"` : null,
    `Unread: ${data.unread}`,
    `Pending directed: ${data.pendingDirected}`,
    data.role ? `Your role: ${data.role}` : null,
  ].filter((l): l is string => l != null);

  return { output: lines.join("\n"), rawResult: data };
}

// ── Motd Command ──

export interface MotdArgs {
  json?: string;
  in?: string;
}

/** motd 命令逻辑。 */
export async function motdCommand(ctx: CliContext, args: MotdArgs): Promise<CommandResult> {
  const die = makeDie(ctx.output, "irc");

  const chatId = await ctx.resolveTarget(args.in);
  const result = await ctx.engine.query("/query/chat_mood", { chatId: `channel:${chatId}` });

  return { output: renderHuman(result), rawResult: result };
}

// ── Threads Command ──

export interface ThreadsArgs {
  json?: string;
}

/** threads 命令逻辑。 */
export async function threadsCommand(ctx: CliContext, args: ThreadsArgs): Promise<CommandResult> {
  const result = await ctx.engine.query("/query/open_topics", {});
  return { output: renderHuman(result), rawResult: result };
}

// ── Join Command ──

export interface JoinArgs {
  json?: string;
  target: string;
}

/** join 命令逻辑。 */
export async function joinCommand(ctx: CliContext, args: JoinArgs): Promise<CommandResult> {
  const die = makeDie(ctx.output, "irc");

  const chatIdOrLink = args.target.trim();
  if (!chatIdOrLink) die("join requires a target");

  const result = await ctx.engine.post("/telegram/join", { chatIdOrLink });

  return { output: renderConfirm("Joined", chatIdOrLink), rawResult: result };
}

// ── Leave Command ──

export interface LeaveArgs {
  json?: string;
  in?: string;
}

/** leave 命令逻辑。 */
export async function leaveCommand(ctx: CliContext, args: LeaveArgs): Promise<CommandResult> {
  const die = makeDie(ctx.output, "irc");

  const chatId = await ctx.resolveTarget(args.in);
  const result = await ctx.engine.post("/telegram/leave", { chatId });

  return { output: renderConfirm("Left chat"), rawResult: result };
}
