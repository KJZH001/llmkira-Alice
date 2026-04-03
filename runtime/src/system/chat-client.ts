/**
 * irc — 共享解析工具。
 *
 * ADR-238: 简化为纯工具函数，命令定义在 irc.ts 中。
 *
 * 命令签名设计（IRC 直觉 + POSIX 严格）：
 *   irc say [--in TARGET] <text>
 *   irc reply [--in TARGET] <msgId> <text>
 *   irc react [--in TARGET] <msgId> <emoji>
 *   irc sticker [--in TARGET] <keyword>
 *   irc read [--in TARGET]
 *   irc tail [--in TARGET] [count]
 *   irc whois [--in TARGET] [@ID]
 *   irc motd [--in TARGET]
 *   irc threads
 *   irc topic [--in TARGET]
 *   irc join <target>
 *   irc leave [--in TARGET]
 *   irc forward --from SOURCE --ref <msgId> --to TARGET [comment]
 *
 * --in TARGET = "在哪个聊天室操作"（空间介词，IRC "I'm in #channel"）。
 * --to TARGET 仅用于 forward（方向介词，"转发到"）。
 * TARGET 支持 @ID（聊天平台惯例）、~ID（向后兼容）和裸数字。
 * 省略时自动从 ALICE_CTX_TARGET_CHAT 环境变量获取当前聊天上下文。
 *
 * @see docs/adr/238-citty-native-cli-redesign.md
 */

import { enginePost } from "../../skills/_lib/engine-client.js";

// ── 共享解析工具 ──

/**
 * 解析 --in TARGET（或 forward 的 --to/--from TARGET）。
 *
 * ADR-237: 支持名称解析。
 * - 数字 ID / @数字 / ~数字 → 直接返回数字
 * - 名称 / @名称 → 调用 Engine API /resolve/name 解析
 *
 * 省略时自动从 ALICE_CTX_TARGET_CHAT 环境变量获取当前聊天上下文。
 */
export async function resolveTarget(raw?: string): Promise<number> {
  const effective = raw || process.env.ALICE_CTX_TARGET_CHAT;
  if (!effective) {
    throw new Error("missing target: use --in @ID");
  }

  // 去掉 @ 或 ~ 前缀
  const stripped =
    effective.startsWith("@") || effective.startsWith("~") ? effective.slice(1) : effective;

  // 尝试解析为数字
  const n = Number(stripped);
  if (Number.isFinite(n)) {
    return n;
  }

  // 不是数字 → 尝试名称解析
  // 调用 Engine API /resolve/name
  const result = (await enginePost("/resolve/name", { name: effective })) as {
    result?: { telegramId: number | null } | null;
  };

  if (result?.result?.telegramId != null) {
    return result.result.telegramId;
  }

  throw new Error(`invalid target: "${effective}"`);
}

/**
 * 解析 msgId，容忍 # 前缀（LLM 从 prompt 中 (#5791) 复制）。
 */
export function parseMsgId(raw: string): number {
  const stripped = raw.startsWith("#") ? raw.slice(1) : raw;
  const n = Number(stripped);
  if (!Number.isFinite(n))
    throw new Error(`invalid message ID: "${raw}" (expected a number like 5791)`);
  return n;
}

// ── --in 选项定义（所有需要 target 的 subcommand 共用）──

export const inOption = {
  type: "string" as const,
  description: "Target chat (@ID or numeric). Omit to use current chat context.",
};
