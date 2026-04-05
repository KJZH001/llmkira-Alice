import { describe, expect, it } from "vitest";
import { buildShellGuide } from "../src/engine/act/shell-guide.js";

describe("buildShellGuide", () => {
  it("prefers batched observe-then-act group examples when tags are cautious and observing", () => {
    const guide = buildShellGuide({
      chatTargetType: "group",
      facetTags: ["cautious", "observing", "engaged"],
      hasBots: false,
    });

    const batchedTitle = "need a beat to catch up — read first, then chime in once";
    const contextOnlyTitle = "dropped into an unfamiliar group — look before you leap";

    expect(guide).toContain(batchedTitle);
    expect(guide).toContain("irc tail --count 8");
    expect(guide).toContain('irc reply --ref 3390931 --text "我也是这么觉得 前面那句太好笑了"');
    expect(guide).toContain("irc read");

    expect(guide.indexOf(batchedTitle)).toBeGreaterThan(-1);
    expect(guide.indexOf(contextOnlyTitle)).toBeGreaterThan(-1);
    expect(guide.indexOf(batchedTitle)).toBeLessThan(guide.indexOf(contextOnlyTitle));
  });
});
