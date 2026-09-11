import { describe, expect, it } from "vitest";
import { formatSyncOutcome } from "./registry-command.js";

describe("formatSyncOutcome", () => {
  it("names the SHA and the three counts, with the excluded count derived", () => {
    const text = formatSyncOutcome({
      sha: "55c04572476c4999e4ff6c53a73853fb75cbd18c",
      derivedCount: 199,
      mergedCount: 163,
      siteCount: 163,
    });
    expect(text).toContain("55c04572476c4999e4ff6c53a73853fb75cbd18c");
    expect(text).toContain("199 app directories derived");
    expect(text).toContain("163 became");
    expect(text).toContain("36 excluded by curation");
    expect(text).toContain("163 probed");
  });
});
