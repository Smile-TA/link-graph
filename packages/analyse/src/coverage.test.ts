import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIN_TRUTH_SOURCE_COVERAGE_PCT,
  truthSourceCoverageProblem,
} from "./coverage.js";

const problem = (
  covered: number,
  inventory: number | null,
  minPct = DEFAULT_MIN_TRUTH_SOURCE_COVERAGE_PCT,
) => truthSourceCoverageProblem(covered, inventory, minPct);

describe("truthSourceCoverageProblem", () => {
  it("passes a crawl that covers the whole inventory", () => {
    // 403bplan.net, the one complete crawl that exists: 13 of 13.
    expect(problem(13, 13)).toBeNull();
  });

  it("refuses the step-3 captures, which is what it was built for", () => {
    // The four captures, by their in-truth-source page count over their sitemap size:
    // integrity.com 1 of 1,953 (previously reported as 0 orphans), 403bplan.net 1 of 13
    // (its second capture is the `?ref=lgtest` duplicate, which is not in the sitemap),
    // lionstreet.com 1 of 55, tidewatermg.com 1 of 989.
    expect(problem(1, 1953)).toMatch(/page rows for 1 of the 1953 URL\(s\).*0\.051%/);
    expect(problem(1, 13)).toMatch(/7\.7%/);
    expect(problem(1, 55)).toMatch(/1\.8%/);
    expect(problem(1, 989)).toMatch(/below the required 90%/);
  });

  it("refuses an inventory of nothing rather than dividing by it", () => {
    // (0/0)*100 is NaN and NaN < 90 is false, so without this the one input the module
    // exists to reject comes back as "no problem".
    expect(problem(0, 0)).toMatch(/not an inventory/);
    expect(problem(0, -1)).toMatch(/not an inventory/);
  });

  it("refuses a crawl of a truth-source site that never recorded its size", () => {
    expect(problem(13, null)).toMatch(/records no truth_source_urls/);
  });

  it("refuses more truth-source pages than the truth source held", () => {
    expect(problem(13, 12)).toMatch(/13 page\(s\) marked in_truth_source but.*held 12/);
  });

  it("puts the boundary at the threshold itself, inclusive", () => {
    expect(problem(9, 10, 90)).toBeNull();
    expect(problem(89, 100, 90)).toMatch(/89\.0%, below the required 90%/);
    expect(problem(9, 1000, 90)).toMatch(/0\.90%/); // two significant figures, not "0.9"
    expect(problem(12, 13, 90)).toBeNull(); // 92.3% — one page of a 13-URL site
    expect(problem(12, 13, 95)).toMatch(/92\.3%/);
  });

  it("keeps 90 as the default until step 7 measures one", () => {
    expect(DEFAULT_MIN_TRUTH_SOURCE_COVERAGE_PCT).toBe(90);
  });
});
