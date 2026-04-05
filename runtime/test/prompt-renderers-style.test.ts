import { describe, expect, it } from "vitest";
import { lintPromptStyle } from "../src/core/prompt-style.js";
import { renderChannel } from "../src/prompt/renderers/channel.js";
import { renderGroup } from "../src/prompt/renderers/group.js";
import { renderPrivate } from "../src/prompt/renderers/private.js";
import type { UserPromptSnapshot } from "../src/prompt/types.js";

function makeSnapshot(chatTargetType: UserPromptSnapshot["chatTargetType"]): UserPromptSnapshot {
  return {
    chatTargetType,
    nowMs: Date.UTC(2026, 3, 5, 3, 0, 0),
    timezoneOffset: 0,
    moodLabel: "neutral",
    target: {
      id: chatTargetType === "group" ? -1001234567890 : 42,
      displayName: chatTargetType === "group" ? "Test Group" : "Test Contact",
      chatType: chatTargetType === "group" ? "supergroup" : "private",
    },
    groupMeta:
      chatTargetType === "group"
        ? {
            directed: false,
            membersInfo: "128 members",
          }
        : undefined,
    contacts: [],
    groups: [],
    ownedChannels: [],
    timeline: { lines: [] },
    threads: [{ threadId: "42", title: "Test topic" }],
    feedback: [],
    whisper: "stay calm",
    conversationRecap: [
      {
        timeRange: "09:00-09:10",
        messageCount: 2,
        first: "Alice: hello there",
        last: "Test Contact: hi back",
      },
    ],
    jargon: [],
    situationSignals: [],
    scheduledEvents: [],
    riskFlags: [],
    isDegraded: false,
    feedItems: [],
  };
}

describe("prompt renderers style", () => {
  it("group renderer 输出通过 prompt-style lint", () => {
    const text = renderGroup(makeSnapshot("group"));

    expect(text).toContain("## Open topics");
    expect(text).toContain("Alice: hello there");
    expect(text).not.toContain("\n  Alice: hello there");
    expect(lintPromptStyle(text)).toEqual([]);
  });

  it("private renderer 输出通过 prompt-style lint", () => {
    const text = renderPrivate(makeSnapshot("private_person"));

    expect(text).toContain("## Open topics");
    expect(text).toContain("Test Contact: hi back");
    expect(text).not.toContain("\n  Test Contact: hi back");
    expect(lintPromptStyle(text)).toEqual([]);
  });

  it("channel renderer 输出通过 prompt-style lint", () => {
    const text = renderChannel({
      ...makeSnapshot("channel_other"),
      target: {
        id: -100987654321,
        displayName: "Tech Feed",
        chatType: "channel",
      },
      contacts: [
        {
          ref: { id: 7, displayName: "Alice Friend", chatType: "private" },
          tierLabel: "close",
          topTrait: "curious",
          interests: ["compiler", "haskell"],
        },
      ],
      timeline: { lines: ["[09:00] Tech Feed (#10): new compiler release"] },
      feedItems: [{ title: "HN", url: "https://example.com", snippet: "FP thread is trending" }],
    });

    expect(text).toContain("## People you might share with");
    expect(text).toContain("## Recent posts (channel, you can read but not post)");
    expect(text).toContain("## From the web");
    expect(lintPromptStyle(text)).toEqual([]);
  });
});
