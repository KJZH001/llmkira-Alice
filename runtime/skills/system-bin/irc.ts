/**
 * irc — IRC-native Telegram system client (CLI 入口)。
 *
 * ADR-238: citty 原生方案，符合 Unix 标准。
 * - 所有参数由 citty 解析，不手动处理 rawArgs
 * - 多词参数由 shell 引号处理，CLI 不宽容
 * - 类型定义与运行时行为严格一致
 *
 * @see docs/adr/238-citty-native-cli-redesign.md
 */

import { defineCommand, runMain } from "citty";
import { parseMsgId, resolveTarget } from "../../src/system/chat-client.ts";
import { renderConfirm } from "../../src/system/cli-bridge.ts";
import {
  joinCommand,
  leaveCommand,
  motdCommand,
  reactCommand,
  readCommand,
  replyCommand,
  sayCommand,
  stickerCommand,
  tailCommand,
  threadsCommand,
  voiceCommand,
  whoisCommand,
} from "../../src/system/cli-commands.ts";
import { createRealContext } from "../../src/system/cli-io.ts";
import { type CommandName, filterOutput, parseOutputMode } from "../../src/system/cli-json.ts";
import type { CliContext } from "../../src/system/cli-types.ts";
import { engineGet, enginePost } from "../_lib/engine-client.ts";

// ── Shared Args Definitions ──

/** --in 选项：目标聊天。 */
const inOption = {
  type: "string" as const,
  description: "Target chat (@ID or numeric). Omit to use current chat context.",
};

/** --json 选项：指定输出字段（逗号分隔）。无参数则输出全部字段。 */
const jsonFlag = {
  json: {
    type: "string" as const,
    description: "Output as JSON with specified fields (comma-separated). Omit for human-readable.",
    valueHint: "fields",
  },
};

// ── Command Result & Runner ──

/** 命令执行结果。 */
interface CommandResult {
  action?: string;
  output: string;
  /** 原始结果对象（用于 JSON 字段过滤）。 */
  rawResult?: unknown;
}

/** citty run 函数签名。 */
type CittyRun<A = Record<string, unknown>> = (ctx: { args: A }) => Promise<void>;

/**
 * 创建命令执行器。
 * ADR-239: --json 接受字段列表，验证 + 过滤输出。
 */
function makeRunner<A extends { json?: string }>(
  command: CommandName,
  handler: (ctx: CliContext, args: A) => Promise<CommandResult>,
): CittyRun<A> {
  return async (cittyCtx) => {
    const ctx = createRealContext();
    const { json } = cittyCtx.args;

    // 解析输出模式
    const mode = parseOutputMode(command, json);

    // 执行命令
    const result = await handler(ctx, cittyCtx.args);

    // 输出
    if (result.action) console.log(result.action);

    switch (mode.type) {
      case "human":
        console.log(result.output);
        break;
      case "json": {
        const filtered = filterOutput(result.rawResult as Record<string, unknown>, mode.fields);
        console.log(JSON.stringify(filtered, null, 2));
        break;
      }
    }
  };
}

// ── Core Subcommands ──

const say = defineCommand({
  meta: { name: "say", description: "Send a message" },
  args: {
    ...jsonFlag,
    in: inOption,
    text: { type: "positional", description: "Message text", required: true },
    "resolve-thread": {
      type: "string",
      description: "Thread ID to resolve after sending",
    },
  },
  run: makeRunner("say", sayCommand),
});

const reply = defineCommand({
  meta: { name: "reply", description: "Reply to a message" },
  args: {
    ...jsonFlag,
    in: inOption,
    msgId: { type: "positional", description: "Message ID to reply to", required: true },
    text: { type: "positional", description: "Reply text", required: true },
  },
  run: makeRunner("reply", replyCommand),
});

const react = defineCommand({
  meta: { name: "react", description: "React to a message" },
  args: {
    ...jsonFlag,
    in: inOption,
    msgId: { type: "positional", description: "Message ID to react to", required: true },
    emoji: { type: "positional", description: "Emoji", required: true },
  },
  run: makeRunner("react", reactCommand),
});

const sticker = defineCommand({
  meta: { name: "sticker", description: "Send a sticker by keyword" },
  args: {
    ...jsonFlag,
    in: inOption,
    keyword: {
      type: "positional",
      description: "Sticker keyword (emotion/action)",
      required: true,
    },
  },
  run: makeRunner("sticker", stickerCommand),
});

const voice = defineCommand({
  meta: { name: "voice", description: "Send a voice message (text-to-speech)" },
  args: {
    ...jsonFlag,
    in: inOption,
    emotion: { type: "string", description: "Emotion: happy, sad, angry, calm, whisper, ..." },
    ref: { type: "string", description: "Message ID to reply to" },
    text: { type: "positional", description: "Text to speak", required: true },
  },
  run: makeRunner("voice", voiceCommand),
});

const read = defineCommand({
  meta: { name: "read", description: "Mark chat as read" },
  args: {
    ...jsonFlag,
    in: inOption,
  },
  run: makeRunner("read", readCommand),
});

const tail = defineCommand({
  meta: { name: "tail", description: "Show recent messages" },
  args: {
    ...jsonFlag,
    in: inOption,
    count: { type: "positional", description: "Number of messages", default: "20" },
  },
  run: makeRunner("tail", tailCommand),
});

const whois = defineCommand({
  meta: { name: "whois", description: "Look up a contact or the current chat room" },
  args: {
    ...jsonFlag,
    in: inOption,
    target: {
      type: "positional",
      description: "Contact name or @ID (omit for room info)",
      multiple: true,
    },
  },
  run: makeRunner("whois", whoisCommand),
});

const motd = defineCommand({
  meta: { name: "motd", description: "Show chat mood and atmosphere" },
  args: {
    ...jsonFlag,
    in: inOption,
  },
  run: makeRunner("motd", motdCommand),
});

const threads = defineCommand({
  meta: { name: "threads", description: "Show open discussion threads" },
  args: jsonFlag,
  run: makeRunner("threads", threadsCommand),
});

const join = defineCommand({
  meta: { name: "join", description: "Join a chat" },
  args: {
    ...jsonFlag,
    target: {
      type: "positional",
      description: "Chat ID, @username, or invite link",
      required: true,
    },
  },
  run: makeRunner("join", joinCommand),
});

const leave = defineCommand({
  meta: { name: "leave", description: "Leave current chat" },
  args: {
    ...jsonFlag,
    in: inOption,
  },
  run: makeRunner("leave", leaveCommand),
});

// ── Additional Commands (inline implementations) ──

const ACTION_PREFIX = "__ALICE_ACTION__:";

/** 从 graph 响应中提取 value。 */
function gval(res: unknown): unknown {
  return (res as { value?: unknown } | null)?.value ?? null;
}

/** 输出处理辅助函数（用于内联命令）。 */
function outputMode(json: string | undefined, rawResult: unknown, humanText: string): void {
  const mode = parseOutputMode("topic", json); // topic 作为 fallback
  switch (mode.type) {
    case "human":
      console.log(humanText);
      break;
    case "json": {
      const filtered = filterOutput(rawResult as Record<string, unknown>, mode.fields);
      console.log(JSON.stringify(filtered, null, 2));
      break;
    }
  }
}

const topic = defineCommand({
  meta: { name: "topic", description: "Show chat topic" },
  args: {
    ...jsonFlag,
    in: inOption,
  },
  async run({ args }) {
    const chatId = await resolveTarget(args.in as string | undefined);
    const topicResult = await engineGet(`/graph/channel:${chatId}/topic`);
    const topicValue = gval(topicResult);
    const rawResult = { chatId, topic: topicValue };
    outputMode(args.json, rawResult, topicValue ? `Topic: "${topicValue}"` : "(no topic)");
  },
});

const download = defineCommand({
  meta: { name: "download", description: "Download a file attachment from a message" },
  args: {
    ...jsonFlag,
    in: inOption,
    ref: { type: "string", description: "Message ID containing the attachment", required: true },
    output: {
      type: "string",
      description: "Output path (must be under $ALICE_HOME)",
      required: true,
    },
  },
  async run({ args }) {
    const chatId = await resolveTarget(args.in as string | undefined);
    const msgId = parseMsgId(args.ref as string);
    const outputPath = (args.output as string).trim();

    const result = (await enginePost("/telegram/download", {
      chatId,
      msgId,
      output: outputPath,
    })) as { path?: string; mime?: string; size?: number } | null;

    if (result?.path) {
      console.log(`${ACTION_PREFIX}downloaded:chatId=${chatId}:msgId=${msgId}:path=${result.path}`);
    }

    const detail = result?.path ?? outputPath;
    const size = result?.size != null ? ` (${result.size} bytes)` : "";
    outputMode(args.json, result, renderConfirm("Downloaded", `${detail}${size}`));
  },
});

const sendFile = defineCommand({
  meta: { name: "send-file", description: "Send a local file to a chat" },
  args: {
    ...jsonFlag,
    in: inOption,
    path: { type: "string", description: "File path (must be under $ALICE_HOME)", required: true },
    caption: { type: "string", description: "Optional caption" },
    ref: { type: "string", description: "Message ID to reply to" },
  },
  async run({ args }) {
    const chatId = await resolveTarget(args.in as string | undefined);
    const filePath = (args.path as string).trim();

    const body: Record<string, unknown> = { chatId, path: filePath };
    if (args.caption) body.caption = args.caption;
    if (args.ref) body.replyTo = parseMsgId(args.ref as string);

    const result = (await enginePost("/telegram/upload", body)) as { msgId?: number } | null;

    if (result?.msgId != null) {
      console.log(`${ACTION_PREFIX}sent-file:chatId=${chatId}:path=${filePath}`);
    }
    outputMode(args.json, result, renderConfirm("Sent file", filePath));
  },
});

const forward = defineCommand({
  meta: {
    name: "forward",
    description: "Forward a message to another chat (with optional comment)",
  },
  args: {
    ...jsonFlag,
    from: {
      type: "string",
      description: "Source chat (@ID or numeric)",
      required: true,
    },
    ref: { type: "string", description: "Message ID to forward", required: true },
    to: {
      type: "string",
      description: "Destination chat (@ID or numeric). Omit to use current chat context.",
    },
    text: {
      type: "positional",
      description: "Optional comment (attached as reply to forwarded message)",
      default: "",
    },
  },
  async run({ args }) {
    const fromChatId = await resolveTarget(args.from as string);
    const msgId = parseMsgId(args.ref as string);
    const toChatId = await resolveTarget(args.to as string | undefined);
    const comment = (args.text as string | undefined)?.trim() || undefined;

    const result = (await enginePost("/telegram/forward", {
      fromChatId,
      msgId,
      toChatId,
      ...(comment && { comment }),
    })) as { forwardedMsgId?: number; commentMsgId?: number } | null;

    if (result?.forwardedMsgId != null) {
      console.log(
        `${ACTION_PREFIX}forwarded:from=${fromChatId}:to=${toChatId}:msgId=${result.forwardedMsgId}`,
      );
    }
    if (result?.commentMsgId != null) {
      console.log(`${ACTION_PREFIX}sent:chatId=${toChatId}:msgId=${result.commentMsgId}`);
    }
    outputMode(args.json, result, renderConfirm("Forwarded", `#${msgId} → @${toChatId}`));
  },
});

// ── Main Command ──

const main = defineCommand({
  meta: {
    name: "irc",
    description: "Telegram system chat client for Alice",
  },
  subCommands: {
    say,
    reply,
    react,
    sticker,
    voice,
    read,
    tail,
    whois,
    motd,
    threads,
    topic,
    join,
    leave,
    download,
    "send-file": sendFile,
    forward,
  },
});

runMain(main);
