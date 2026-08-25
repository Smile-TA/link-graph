import { describe, expect, it } from "vitest";
import { classifyPage, type PageFacts, type SiteRules } from "./classify.js";

/**
 * A page that is in the truth source, serves 200, is indexable, and has one ordinary
 * inbound edge. Every case below changes exactly one fact, so the fact under test is
 * the only thing that can move the answer.
 */
const page = (overrides: Partial<PageFacts> = {}): PageFacts => ({
  urlNormalized: "https://403bplan.net/newsletters/",
  path: "/newsletters/",
  statusCode: 200,
  indexable: true,
  canonicalTo: "https://403bplan.net/newsletters/",
  redirectTo: null,
  inTruthSource: true,
  isCrawlRoot: false,
  inboundTotal: 1,
  ...overrides,
});

const sitemapSite: SiteRules = {
  truthSource: "sitemap",
  crawlScope: "full",
  ignorePaths: [],
};

/** The same site crawled to a ceiling instead of exhaustively (PRD §15). */
const sampledSite: SiteRules = { ...sitemapSite, crawlScope: "sample" };

describe("classifyPage", () => {
  it("is linked when an inbound edge exists", () => {
    expect(classifyPage(page(), sitemapSite)).toBe("linked");
  });

  it("is a true orphan with zero inbound edges", () => {
    expect(classifyPage(page({ inboundTotal: 0 }), sitemapSite)).toBe("orphan");
  });

  /**
   * The soft-orphan class, dropped 2026-08-20 (PRD §2). A page with inbound edges is
   * linked however those edges are styled: measured on 403bplan.net, `/contact-us/`
   * has two genuine in-content links whose anchor happens to match the header nav
   * entry, so both were marked boilerplate and the page classified `soft_orphan` —
   * one of that site's three soft orphans was simply wrong. 13 boilerplate-only
   * inbound edges is exactly that shape.
   */
  it("is linked when every inbound edge is boilerplate", () => {
    expect(classifyPage(page({ inboundTotal: 13 }), sitemapSite)).toBe("linked");
  });

  /**
   * Measured on 403bplan.net: the homepage's only inbound edges are 13 header logo
   * links with an empty anchor, so the (target, anchor) pair is on 100% of pages and
   * every inbound edge is boilerplate. That made the homepage a soft orphan under the
   * dropped rule; the rule is gone, but the crawl root still cannot be an orphan when
   * it has no inbound edges at all, and a report opening with "your homepage is an
   * orphan" is the false positive PRD §13 says destroys trust.
   */
  it("never reports the crawl root as an orphan, however its inbound edges look", () => {
    expect(classifyPage(page({ isCrawlRoot: true, inboundTotal: 13 }), sitemapSite)).toBe(
      "linked",
    );
    expect(classifyPage(page({ isCrawlRoot: true, inboundTotal: 0 }), sitemapSite)).toBe(
      "linked",
    );
  });

  describe("excluded (PRD §2) outranks every orphan test", () => {
    const orphaned = { inboundTotal: 0 } as const;

    it("excludes a noindex page", () => {
      expect(classifyPage(page({ ...orphaned, indexable: false }), sitemapSite)).toBe(
        "excluded",
      );
    });

    it("excludes a page whose canonical points elsewhere", () => {
      expect(
        classifyPage(
          page({ ...orphaned, canonicalTo: "https://403bplan.net/newsletter-signup/" }),
          sitemapSite,
        ),
      ).toBe("excluded");
    });

    it("does not exclude a page whose canonical points at itself", () => {
      expect(classifyPage(page(orphaned), sitemapSite)).toBe("orphan");
    });

    it("does not exclude a page that declared no canonical at all", () => {
      expect(classifyPage(page({ ...orphaned, canonicalTo: null }), sitemapSite)).toBe(
        "orphan",
      );
    });

    it("excludes a redirect", () => {
      expect(
        classifyPage(
          page({
            ...orphaned,
            statusCode: 301,
            redirectTo: "https://403bplan.net/newsletter-signup/",
          }),
          sitemapSite,
        ),
      ).toBe("excluded");
    });

    it("excludes a truth-source URL that does not serve — it is a broken inventory entry, not an orphan", () => {
      expect(classifyPage(page({ ...orphaned, statusCode: 404 }), sitemapSite)).toBe(
        "excluded",
      );
      expect(classifyPage(page({ ...orphaned, statusCode: 500 }), sitemapSite)).toBe(
        "excluded",
      );
    });

    it("still classifies a page the crawl never fetched, because inbound edges come from elsewhere", () => {
      expect(classifyPage(page({ ...orphaned, statusCode: null }), sitemapSite)).toBe(
        "orphan",
      );
    });

    it("excludes an ignore_paths match on the entry itself and on anything below it", () => {
      const site: SiteRules = { ...sitemapSite, ignorePaths: ["/newsletters/"] };
      expect(classifyPage(page(orphaned), site)).toBe("excluded");
      expect(classifyPage(page({ ...orphaned, path: "/newsletters/2026/" }), site)).toBe(
        "excluded",
      );
    });

    it("does not let an ignore_paths entry match a sibling that merely shares a prefix", () => {
      const site: SiteRules = { ...sitemapSite, ignorePaths: ["/newsletter"] };
      expect(classifyPage(page(orphaned), site)).toBe("orphan");
    });
  });

  /**
   * PRD §2, Undetectable: a site with no truth source has no inventory to take the set
   * difference against, so it must report a coverage gap and never "0 orphans"
   * (engineering guide §1). `null` is "not resolved yet" and 'none' is "resolved, and
   * there is none" — neither can answer the orphan question.
   */
  describe("undetectable", () => {
    for (const truthSource of [null, "none"] as const) {
      it(`reports every page as undetectable when truth_source is ${String(truthSource)}`, () => {
        const site: SiteRules = { ...sitemapSite, truthSource };
        expect(classifyPage(page({ inboundTotal: 0, inTruthSource: false }), site)).toBe(
          "undetectable",
        );
        expect(classifyPage(page(), site)).toBe("undetectable");
      });
    }

    it("outranks the crawl-root rule, so a noindex homepage is excluded and not linked", () => {
      expect(
        classifyPage(page({ isCrawlRoot: true, indexable: false }), sitemapSite),
      ).toBe("excluded");
    });

    it("still excludes a noindex page on a site with no truth source", () => {
      const site: SiteRules = { ...sitemapSite, truthSource: "none" };
      expect(classifyPage(page({ indexable: false }), site)).toBe("excluded");
    });
  });

  /**
   * A page the crawl reached that the inventory does not list is not an orphan — the
   * orphan question is a set difference against the inventory, and this page is not in
   * it. Calling it `excluded` would mix "excluded by intent" (PRD §2) with "absent from
   * the inventory", which are different findings.
   */
  it("marks a crawled page that is absent from the truth source as such", () => {
    expect(classifyPage(page({ inTruthSource: false }), sitemapSite)).toBe(
      "not_in_truth_source",
    );
    expect(
      classifyPage(page({ inTruthSource: false, inboundTotal: 0 }), sitemapSite),
    ).toBe("not_in_truth_source");
  });
  /**
   * PRD §15, settled 2026-08-20: a templated site is sampled, never crawled whole —
   * `agent.familyfirstlife.com` is 59,363 pages of one template. §2 (step 5.5) carries
   * the per-page consequence: orphan detection is a set difference against the *whole*
   * truth source, so on a sample the absence of an inbound edge is evidence of nothing.
   * One inbound edge still proves `linked`, because positive evidence survives sampling
   * and proving absence does not.
   */
  describe("a sampled crawl (PRD §15)", () => {
    it("cannot call a truth-source page with no inbound edges an orphan", () => {
      expect(classifyPage(page({ inboundTotal: 0 }), sampledSite)).toBe("undetectable");
    });

    it("still reports a page with an inbound edge as linked", () => {
      expect(classifyPage(page(), sampledSite)).toBe("linked");
      expect(classifyPage(page({ inboundTotal: 13 }), sampledSite)).toBe("linked");
    });

    it("still excludes by intent, which sampling does not affect", () => {
      expect(classifyPage(page({ inboundTotal: 0, indexable: false }), sampledSite)).toBe(
        "excluded",
      );
    });

    it("still reports a page the inventory does not list as such", () => {
      expect(
        classifyPage(page({ inboundTotal: 0, inTruthSource: false }), sampledSite),
      ).toBe("not_in_truth_source");
    });

    it("leaves a full crawl of the same site answering the orphan question", () => {
      expect(classifyPage(page({ inboundTotal: 0 }), sitemapSite)).toBe("orphan");
    });
  });
});
