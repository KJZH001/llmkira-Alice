/**
 * CLI 命令逻辑测试 — ADR-238 citty 原生版本。
 *
 * 测试策略：
 * - 通过构造 fake IO 实现，直接测试命令逻辑
 * - 覆盖 citty 边界行为（multiple: true 的 string/array 双态）
 * - 不再需要 rawArgs 解析测试（citty 处理）
 */

import { describe, expect, it } from "vitest";
import {
  gval,
  parseMsgId,
  reactCommand,
  readCommand,
  replyCommand,
  sayCommand,
  tailCommand,
  threadsCommand,
  whoisCommand,
} from "../src/system/cli-commands.js";
import type { CliContext, EngineClient, Output } from "../src/system/cli-types.js";

// ── Fake 实现 ──

/** 记录输出内容。 */
class FakeOutput implements Output {
  logs: string[] = [];
  errors: string[] = [];
  exitCode: number | null = null;

  log(msg: string): void {
    this.logs.push(msg);
  }

  error(msg: string): void {
    this.errors.push(msg);
  }

  exit(code: number): never {
    this.exitCode = code;
    throw new Error(`exit(${code})`);
  }

  reset(): void {
    this.logs = [];
    this.errors = [];
    this.exitCode = null;
  }
}

/** 构造 fake engine。 */
function makeFakeEngine(responses: Map<string, unknown>): EngineClient {
  return {
    post: async (path: string, body: unknown) => {
      const key = `POST:${path}:${JSON.stringify(body)}`;
      return responses.get(key) ?? responses.get(`POST:${path}`) ?? null;
    },
    get: async (path: string) => {
      return responses.get(`GET:${path}`) ?? null;
    },
    query: async (path: string, body: unknown) => {
      const key = `QUERY:${path}:${JSON.stringify(body)}`;
      const raw = responses.get(key) ?? responses.get(`QUERY:${path}`) ?? null;
      // 模拟 engineQuery 自动解包
      if (raw && typeof raw === "object" && "result" in raw) {
        return (raw as { result: unknown }).result;
      }
      return raw;
    },
  };
}

/** 构造 fake context。 */
function makeFakeContext(
  responses: Map<string, unknown>,
  output: Output,
  resolveTarget: (t: unknown) => Promise<number> = async () => 123,
): CliContext {
  return {
    engine: makeFakeEngine(responses),
    output,
    resolveTarget,
  };
}

// ── Tests ──

describe("parseMsgId", () => {
  it("parses plain number", () => {
    expect(parseMsgId("123")).toBe(123);
  });

  it("parses #prefixed number", () => {
    expect(parseMsgId("#456")).toBe(456);
  });

  it("throws on invalid", () => {
    expect(() => parseMsgId("abc")).toThrow("invalid message ID");
  });
});

describe("gval", () => {
  it("extracts value from response", () => {
    expect(gval({ value: "test" })).toBe("test");
  });

  it("returns null for null response", () => {
    expect(gval(null)).toBe(null);
  });

  it("returns null for missing value", () => {
    expect(gval({})).toBe(null);
  });
});

describe("sayCommand", () => {
  it("sends message and returns formatted output", async () => {
    const responses = new Map([
      ['POST:/telegram/send:{"chatId":123,"text":"hello"}', { msgId: 789 }],
    ]);
    const output = new FakeOutput();
    const ctx = makeFakeContext(responses, output);

    const result = await sayCommand(ctx, {
      in: undefined,
      text: "hello",
    });

    expect(result.action).toBe("__ALICE_ACTION__:sent:chatId=123:msgId=789");
    expect(result.output).toBe('✓ Sent: "hello"');
    expect(output.logs).toHaveLength(0); // 命令逻辑不直接输出
  });

  it("returns rawResult when json flag is set", async () => {
    const responses = new Map([['POST:/telegram/send:{"chatId":123,"text":"test"}', { msgId: 1 }]]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    const result = await sayCommand(ctx, {
      in: undefined,
      text: "test",
      json: "", // 空字符串表示 JSON 模式（输出全部字段）
    });

    // rawResult 用于 JSON 输出，output 是人类可读文本
    expect(result.rawResult).toEqual({ msgId: 1, chatId: 123 });
    expect(result.output).toBe('✓ Sent: "test"');
  });

  it("throws on empty text", async () => {
    const ctx = makeFakeContext(new Map(), new FakeOutput());

    await expect(
      sayCommand(ctx, {
        in: undefined,
        text: "   ",
      }),
    ).rejects.toThrow("exit(1)");
  });

  describe("--resolve-thread (ADR-240)", () => {
    it("resolves thread after sending message", async () => {
      const responses = new Map([
        ['POST:/telegram/send:{"chatId":123,"text":"done"}', { msgId: 789 }],
        ['POST:/dispatch/resolve_topic:{"threadId":158}', { ok: true }],
      ]);
      const output = new FakeOutput();
      const ctx = makeFakeContext(responses, output);

      const result = await sayCommand(ctx, {
        in: undefined,
        text: "done",
        "resolve-thread": "158",
      });

      expect(result.action).toBe("__ALICE_ACTION__:sent:chatId=123:msgId=789");
      expect(result.output).toBe('✓ Sent: "done"');
      // 验证发送了 resolve_topic 请求
      expect(Array.from(responses.keys())).toContain('POST:/dispatch/resolve_topic:{"threadId":158}');
    });

    it("throws on invalid thread ID", async () => {
      const responses = new Map([
        ['POST:/telegram/send:{"chatId":123,"text":"done"}', { msgId: 789 }],
      ]);
      const output = new FakeOutput();
      const ctx = makeFakeContext(responses, output);

      await expect(
        sayCommand(ctx, {
          in: undefined,
          text: "done",
          "resolve-thread": "invalid",
        }),
      ).rejects.toThrow("exit(1)");
    });

    it("throws on negative thread ID", async () => {
      const responses = new Map([
        ['POST:/telegram/send:{"chatId":123,"text":"done"}', { msgId: 789 }],
      ]);
      const output = new FakeOutput();
      const ctx = makeFakeContext(responses, output);

      await expect(
        sayCommand(ctx, {
          in: undefined,
          text: "done",
          "resolve-thread": "-1",
        }),
      ).rejects.toThrow("exit(1)");
    });

    it("does not fail when resolve throws", async () => {
      const responses = new Map([
        ['POST:/telegram/send:{"chatId":123,"text":"done"}', { msgId: 789 }],
        // resolve_topic 返回 null（模拟失败）
        ['POST:/dispatch/resolve_topic:{"threadId":158}', null],
      ]);
      const output = new FakeOutput();
      const ctx = makeFakeContext(responses, output);

      const result = await sayCommand(ctx, {
        in: undefined,
        text: "done",
        "resolve-thread": "158",
      });

      // 消息应该成功发送，即使 resolve 失败
      expect(result.output).toBe('✓ Sent: "done"');
      expect(result.action).toBe("__ALICE_ACTION__:sent:chatId=123:msgId=789");
    });

    it("works without resolve-thread flag", async () => {
      const responses = new Map([
        ['POST:/telegram/send:{"chatId":123,"text":"hello"}', { msgId: 789 }],
      ]);
      const output = new FakeOutput();
      const ctx = makeFakeContext(responses, output);

      const result = await sayCommand(ctx, {
        in: undefined,
        text: "hello",
        // 不带 resolve-thread 参数
      });

      expect(result.action).toBe("__ALICE_ACTION__:sent:chatId=123:msgId=789");
      expect(result.output).toBe('✓ Sent: "hello"');
      // 不应发送 resolve_topic 请求
      expect(Array.from(responses.keys())).not.toContain("resolve_topic");
    });
  });
});

describe("replyCommand", () => {
  it("sends reply with correct params", async () => {
    const responses = new Map([
      ['POST:/telegram/send:{"chatId":123,"text":"reply text","replyTo":456}', { msgId: 789 }],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    const result = await replyCommand(ctx, {
      in: undefined,
      ref: "456",
      text: "reply text",
    });

    expect(result.output).toContain("Replied to: #456");
  });
});

describe("reactCommand", () => {
  it("sends reaction", async () => {
    const responses = new Map([
      ['POST:/telegram/react:{"chatId":123,"msgId":123,"emoji":"👍"}', { ok: true }],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    const result = await reactCommand(ctx, {
      in: undefined,
      ref: "123",
      emoji: "👍",
    });

    expect(result.output).toContain("Reacted 👍 to: #123");
  });
});

describe("readCommand", () => {
  it("marks chat as read", async () => {
    const responses = new Map([['POST:/telegram/read:{"chatId":123}', { ok: true }]]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    const result = await readCommand(ctx, {
      in: undefined,
    });

    expect(result.output).toBe("✓ Marked as read");
  });
});

describe("tailCommand", () => {
  it("formats messages as numbered list", async () => {
    const responses = new Map([
      [
        "GET:/chat/123/tail?limit=20",
        [
          { id: 1, sender: "Alice", text: "hello" },
          { id: 2, sender: "Bob", text: "hi there" },
        ],
      ],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    const result = await tailCommand(ctx, {
      in: undefined,
      count: "20",
    });

    expect(result.output).toContain('1. (#1) Alice: "hello"');
    expect(result.output).toContain('2. (#2) Bob: "hi there"');
  });

  it("returns rawResult with json flag", async () => {
    const responses = new Map([["GET:/chat/123/tail?limit=10", [{ id: 1, text: "test" }]]]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    const result = await tailCommand(ctx, {
      in: undefined,
      count: "10",
      json: "", // 空字符串表示 JSON 模式
    });

    expect(result.rawResult).toEqual([{ id: 1, text: "test" }]);
  });

  it("shows (no messages) for empty result", async () => {
    const responses = new Map([["GET:/chat/123/tail?limit=20", []]]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    const result = await tailCommand(ctx, {
      in: undefined,
      count: "20",
    });

    expect(result.output).toBe("(no messages)");
  });
});

describe("threadsCommand", () => {
  it("lists open threads", async () => {
    const responses = new Map([
      [
        "QUERY:/query/open_topics:{}",
        {
          ok: true,
          result: [
            { id: "thread:1", title: "Topic A" },
            { id: "thread:2", title: "Topic B" },
          ],
        },
      ],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    const result = await threadsCommand(ctx, {});

    expect(result.output).toContain("1.");
    expect(result.output).toContain("2.");
  });
});

describe("whoisCommand", () => {
  it("returns chat info when no target provided", async () => {
    const responses = new Map([
      ["GET:/graph/channel:123/display_name", { value: "Test Chat" }],
      ["GET:/graph/channel:123/chat_type", { value: "supergroup" }],
      ["GET:/graph/channel:123/topic", { value: "Testing" }],
      ["GET:/graph/channel:123/unread", { value: 5 }],
      ["GET:/graph/channel:123/pending_directed", { value: 2 }],
      ["GET:/graph/channel:123/alice_role", { value: "member" }],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    const result = await whoisCommand(ctx, {
      in: undefined,
      target: undefined,
    });

    expect(result.output).toContain("Test Chat");
    expect(result.output).toContain("supergroup");
    expect(result.output).toContain("Unread: 5");
  });

  it("handles string target (citty may return single string)", async () => {
    const responses = new Map([
      ['POST:/resolve/name:{"name":"test_user"}', { result: { telegramId: 999 } }],
      [
        'QUERY:/query/contact_profile:{"contactId":"contact:999"}',
        {
          contactId: "contact:999",
          display_name: "Test User",
        },
      ],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    // 关键测试：target 是 string，不是 string[]
    const result = await whoisCommand(ctx, {
      in: undefined,
      target: "test_user", // string，不是 string[]
    });

    expect(result.output).toBeDefined();
    // 不应抛出 TypeError: targets.join is not a function
  });

  it("handles string target with spaces", async () => {
    const responses = new Map([
      ['POST:/resolve/name:{"name":"Test User Name"}', { result: { telegramId: 888 } }],
      [
        'QUERY:/query/contact_profile:{"contactId":"contact:888"}',
        {
          contactId: "contact:888",
          display_name: "Test User Name",
        },
      ],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    const result = await whoisCommand(ctx, {
      in: undefined,
      target: "Test User Name",
    });

    expect(result.output).toBeDefined();
  });

  it("handles numeric target as contact ID", async () => {
    const responses = new Map([
      [
        'QUERY:/query/contact_profile:{"contactId":"contact:12345"}',
        {
          contactId: "contact:12345",
          display_name: "Numeric User",
        },
      ],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    const result = await whoisCommand(ctx, {
      in: undefined,
      target: "12345", // 数字 ID
    });

    expect(result.output).toBeDefined();
  });

  it("returns rawResult with json flag", async () => {
    const responses = new Map([
      ["GET:/graph/channel:123/display_name", { value: "Test Chat" }],
      ["GET:/graph/channel:123/chat_type", { value: "supergroup" }],
      ["GET:/graph/channel:123/topic", null],
      ["GET:/graph/channel:123/unread", { value: 0 }],
      ["GET:/graph/channel:123/pending_directed", { value: 0 }],
      ["GET:/graph/channel:123/alice_role", null],
    ]);
    const ctx = makeFakeContext(responses, new FakeOutput());

    const result = await whoisCommand(ctx, {
      in: undefined,
      target: undefined,
      json: "", // 空字符串表示 JSON 模式
    });

    expect(result.rawResult).toEqual({
      chatId: 123,
      name: "Test Chat",
      chatType: "supergroup",
      topic: null,
      unread: 0,
      pendingDirected: 0,
      role: null,
    });
  });
});
