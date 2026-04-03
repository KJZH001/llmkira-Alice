import { describe, expect, it } from "vitest";
import { parseKeyValueArgs } from "../src/system/cli-bridge.js";

describe("parseKeyValueArgs", () => {
  it("parses key=value format", () => {
    expect(parseKeyValueArgs(["count=20", "name=test"])).toEqual({
      count: 20,
      name: "test",
    });
  });

  it("parses --key value format (LLM natural style)", () => {
    expect(parseKeyValueArgs(["--count", "20", "--name", "test"])).toEqual({
      count: 20,
      name: "test",
    });
  });

  it("parses mixed format", () => {
    expect(parseKeyValueArgs(["count=20", "--name", "test"])).toEqual({
      count: 20,
      name: "test",
    });
  });

  it("handles boolean flags (--flag without value → true)", () => {
    expect(parseKeyValueArgs(["--verbose"])).toEqual({ verbose: true });
  });

  it("handles string values with spaces via key=value", () => {
    expect(parseKeyValueArgs(["text=hello world"])).toEqual({
      text: "hello world",
    });
  });

  it("parses key value (space-separated)", () => {
    // `count 20` → { count: 20 }
    expect(parseKeyValueArgs(["count", "20"])).toEqual({
      count: 20,
    });
  });

  it("parses numbers, booleans, null correctly", () => {
    expect(parseKeyValueArgs(["num=42", "flag=true", "empty=null"])).toEqual({
      num: 42,
      flag: true,
      empty: null,
    });
  });

  it("parses JSON values", () => {
    expect(parseKeyValueArgs(["list=[1,2,3]", 'obj={"a":1}'])).toEqual({
      list: [1, 2, 3],
      obj: { a: 1 },
    });
  });

  it("throws on invalid format", () => {
    // 单个无值的参数且后面没有值
    expect(() => parseKeyValueArgs(["lonely"])).toThrow("expected key=value or --key value");
  });

  it("stops at next flag when parsing space-separated", () => {
    // `count 20 --flag` → { count: 20, flag: true }
    expect(parseKeyValueArgs(["count", "20", "--flag"])).toEqual({
      count: 20,
      flag: true,
    });
  });
});
