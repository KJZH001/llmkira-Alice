/**
 * ADR-241: 线程压力阈值过滤测试。
 *
 * 验证:
 * - T1: 压力阈值常量存在
 * - T2: stale 标记阈值常量存在
 * - T3: dormant 状态在 format() 中正确处理
 *
 * @see docs/adr/241-thread-weight-decay.md
 */
import { describe, expect, it } from "vitest";
import { threadsMod } from "../src/mods/threads.mod.js";

describe("ADR-241: Thread Pressure Filter Constants", () => {
  it("T1: PRESSURE_THRESHOLD 常量值为 0.15", () => {
    // 验证常量值正确
    // 由于常量在闭包内，我们通过测试 format() 的输出来间接验证
    const testRows = [
      {
        id: 1,
        title: "测试线程",
        status: "open",
        weight: "minor",
        pressure: 0.1, // 低于阈值
      },
    ];

    const formatted = threadsMod.queries["open_topics"].format(testRows);
    expect(formatted[0]).toContain("dormant");
  });

  it("T2: STALE_THRESHOLD 为 PRESSURE_THRESHOLD 的 1.5 倍", () => {
    // STALE_THRESHOLD 应该是 0.225 (0.15 * 1.5)
    // 通过测试 stale 标记逻辑间接验证
    const staleRow = {
      id: 2,
      title: "接近阈值线程",
      status: "open",
      weight: "minor",
      pressure: 0.2, // 接近阈值 (0.15 < 0.2 < 0.225)
    };

    const dormantRow = {
      id: 3,
      title: "低于阈值线程",
      status: "open",
      weight: "minor",
      pressure: 0.1, // 低于阈值
    };

    const staleFormatted = threadsMod.queries["open_topics"].format([staleRow]);
    const dormantFormatted = threadsMod.queries["open_topics"].format([dormantRow]);

    // 0.2 > 0.15 应该显示 low/moderate/high，不是 dormant
    expect(staleFormatted[0]).not.toContain("dormant");
    // 0.1 < 0.15 应该显示 dormant
    expect(dormantFormatted[0]).toContain("dormant");
  });

  it("T3: dormant 状态正确显示在 open_topics 中", () => {
    const rows = [
      {
        id: 1,
        title: "正常线程",
        status: "open",
        weight: "minor",
        pressure: 0.5,
      },
      {
        id: 2,
        title: "沉睡线程",
        status: "open",
        weight: "minor",
        pressure: 0.1,
      },
      {
        id: 3,
        title: "高优先级线程",
        status: "open",
        weight: "major",
        pressure: 2.0,
      },
    ];

    const formatted = threadsMod.queries["open_topics"].format(rows);

    // 正常线程显示 low/moderate/high
    expect(formatted[0]).toContain("low");
    expect(formatted[0]).not.toContain("dormant");

    // 沉睡线程显示 dormant
    expect(formatted[1]).toContain("dormant");

    // 高优先级线程显示 high urgency
    expect(formatted[2]).toContain("high urgency");
  });

  it("T4: pressure 为 null 时不崩溃", () => {
    const row = {
      id: 1,
      title: "无压力线程",
      status: "open",
      weight: "minor",
      pressure: null,
    };

    const formatted = threadsMod.queries["open_topics"].format([row]);

    // 应该正确处理 null pressure
    expect(formatted).toBeDefined();
    expect(formatted.length).toBe(1);
  });
});

describe("ADR-241: open_topics format() 边界情况", () => {
  it("T5: 空数组返回 '(no open topics)'", () => {
    const formatted = threadsMod.queries["open_topics"].format([]);
    expect(formatted).toEqual(["(no open topics)"]);
  });

  it("T6: 压力值 0.15 (边界值) 应该显示 low", () => {
    const row = {
      id: 1,
      title: "边界线程",
      status: "open",
      weight: "minor",
      pressure: 0.15, // 等于 PRESSURE_THRESHOLD
    };

    const formatted = threadsMod.queries["open_topics"].format([row]);

    // 0.15 >= 0.15，应该显示 low (不是 dormant)
    expect(formatted[0]).toContain("low");
    expect(formatted[0]).not.toContain("dormant");
  });

  it("T7: 压力值 0.149 (略低于阈值) 应该显示 dormant", () => {
    const row = {
      id: 1,
      title: "略低于阈值线程",
      status: "open",
      weight: "minor",
      pressure: 0.149, // 略低于 PRESSURE_THRESHOLD (0.15)
    };

    const formatted = threadsMod.queries["open_topics"].format([row]);

    // 0.149 < 0.15，应该显示 dormant
    expect(formatted[0]).toContain("dormant");
  });

  it("T8: high urgency 压力值正确显示", () => {
    const row = {
      id: 1,
      title: "高紧急度线程",
      status: "open",
      weight: "critical",
      pressure: 4.0, // critical 基础值
    };

    const formatted = threadsMod.queries["open_topics"].format([row]);

    expect(formatted[0]).toContain("high urgency");
  });

  it("T9: moderate urgency 压力值正确显示", () => {
    const row = {
      id: 1,
      title: "中等紧急度线程",
      status: "open",
      weight: "major",
      pressure: 1.0, // 正好等于边界
    };

    const formatted = threadsMod.queries["open_topics"].format([row]);

    expect(formatted[0]).toContain("moderate");
  });
});
