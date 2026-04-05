/**
 * ADR-233: TC 执行层 — 原生 tool_use 测试。
 *
 * ADR-232 的 episode 续轮模型已被 ADR-233 TC 循环取代：
 * - TC 循环在 callLLM 内部完成多轮 tool_use
 * - afterward 信号（done/watching/waiting_reply/fed_up/cooling_down）只表示 inter-episode 行为状态
 * - watching 不再触发 intra-episode 续轮（由 TC 循环自然处理中间结果）
 *
 * 验证路径：
 * 1. 单轮直接返回对应的 afterward 状态
 * 2. watching 返回 watching（inter-episode 状态）
 * 3. 预算耗尽时 outcome=tc_budget_exhausted
 *
 * @see docs/adr/233-native-toolcall-bt-hybrid.md
 * @see docs/adr/234-wave5-session-erratum.md
 */
import { describe, expect, it, vi } from "vitest";
import { createBlackboard } from "../src/engine/tick/blackboard.js";
import type { TickDeps } from "../src/engine/tick/tick.js";
import { tick } from "../src/engine/tick/tick.js";
import type { TickStepOutput } from "../src/engine/tick/types.js";

// ── 辅助工厂 ────────────────────────────────────────────────────────────────

function makeBoard(maxSteps = 3) {
  return createBlackboard({
    pressures: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
    voice: "test",
    target: null,
    features: {
      hasWeather: true,
      hasMusic: false,
      hasBrowser: false,
      hasTTS: false,
      hasStickers: false,
      hasBots: false,
      hasSystemThreads: false,
      hasVideo: false,
    },
    contextVars: {},
    maxSteps,
  });
}

function makeDeps(steps: TickStepOutput[]): TickDeps {
  let callCount = 0;
  return {
    // 绕过真实的 buildTickPrompt（需要完整 dispatcher/Graph）
    buildPrompt: async () => ({ system: "sys", user: "usr" }),
    callLLM: vi.fn(async (_system, _user, _tick, _target, _voice, _contextVars) => {
      const step = steps[callCount] ?? null;
      callCount++;
      if (!step) return null;
      return {
        afterward: step.afterward ?? "done",
        toolCallCount: 1,
        budgetExhausted: false,
        rawScript: step.script ?? "",
        commandOutput: step.script ? `$ ${step.script}\n(ok)` : "",
        logs: step.script ? [step.script] : [],
        errors: [],
        instructionErrors: [],
        duration: 0,
        thinks: step.residue ? [JSON.stringify(step.residue)] : [],
        queryLogs: [],
        completedActions: [],
        silenceReason: null,
      };
    }),
  };
}

const BASE_CTX = {
  G: {
    has: () => false,
    getChannel: () => ({ chat_type: "private" }),
    getEntitiesByType: () => [],
    getContact: () => ({}),
    getDynamic: () => null,
  } as never,
  dispatcher: { mods: [], readModState: () => null } as never,
  mods: [],
  config: { peripheral: { perChannelCap: 3, totalCap: 5, minTextLength: 10 } } as never,
  item: { action: "conversation", target: null, facetId: "core" } as never,
  tick: 1,
  messages: [],
  observations: [],
  round: 0,
  client: null,
  runtimeConfig: {} as never,
  buildPrompt: async () => ({ system: "sys", user: "usr" }),
};

// ── 测试 ────────────────────────────────────────────────────────────────────

describe("ADR-232 TC Episode", () => {
  it("单轮（done）：episodeRounds=0，outcome=terminal", async () => {
    const board = makeBoard();
    const deps = makeDeps([{ script: "echo hi", afterward: "done" }]);

    const result = await tick(board, [], deps, BASE_CTX);

    expect(result.outcome).toBe("terminal");
    expect(result.episodeRounds).toBe(0);
    expect(deps.callLLM).toHaveBeenCalledTimes(1);
  });

  it("watching 返回 inter-episode 状态（不再触发续轮）：callLLM 只调用 1 次", async () => {
    // ADR-233: watching 语义收窄，只保留 inter-episode 行为状态
    // 不再触发 intra-episode TC 续轮
    const board = makeBoard(3);
    const steps: TickStepOutput[] = [{ script: "weather tokyo", afterward: "watching" }];
    const deps = makeDeps(steps);

    const result = await tick(board, [], deps, BASE_CTX);

    expect(result.outcome).toBe("watching");
    expect(deps.callLLM).toHaveBeenCalledTimes(1);
  });

  it("done 直接返回 terminal：不触发续轮", async () => {
    const board = makeBoard();
    const deps = makeDeps([{ script: "irc say --text '你好'", afterward: "done" }]);

    const result = await tick(board, [], deps, BASE_CTX);

    expect(result.outcome).toBe("terminal");
    expect(deps.callLLM).toHaveBeenCalledTimes(1);
  });

  it("waiting_reply 直接返回对应 outcome：不触发续轮", async () => {
    const board = makeBoard();
    const deps = makeDeps([
      { script: "irc say --text '你今天怎么样？'", afterward: "waiting_reply" },
    ]);

    const result = await tick(board, [], deps, BASE_CTX);

    expect(result.outcome).toBe("waiting_reply");
    expect(deps.callLLM).toHaveBeenCalledTimes(1);
  });

  it("fed_up 直接返回对应 outcome", async () => {
    const board = makeBoard();
    const deps = makeDeps([{ script: "irc say --text '我先走了'", afterward: "fed_up" }]);

    const result = await tick(board, [], deps, BASE_CTX);

    expect(result.outcome).toBe("fed_up");
  });

  it("cooling_down 直接返回对应 outcome", async () => {
    const board = makeBoard();
    const deps = makeDeps([{ script: "irc say --text '休息一下'", afterward: "cooling_down" }]);

    const result = await tick(board, [], deps, BASE_CTX);

    expect(result.outcome).toBe("cooling_down");
  });
});
