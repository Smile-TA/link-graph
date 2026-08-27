import { describe, expect, it } from "vitest";
import { FETCHERS } from "./fetcher-for-mode.js";
import { createHttpFetcher } from "./fetcher.js";
import { createPlaywrightFetcher } from "./playwright-fetcher.js";

/**
 * Naming a factory is a decision; calling one is I/O. The split is what lets the unit
 * tier check the decision without launching a browser — an inverted map would
 * otherwise only show up as a 33-hour crawl of an HTTP site through Chromium, or as a
 * `playwright` site crawled by the fetcher that cannot see its links.
 */
describe("FETCHERS", () => {
  it("maps each crawler mode to the fetcher PRD §5 names for it", () => {
    expect(FETCHERS.http).toBe(createHttpFetcher);
    expect(FETCHERS.playwright).toBe(createPlaywrightFetcher);
  });
});
