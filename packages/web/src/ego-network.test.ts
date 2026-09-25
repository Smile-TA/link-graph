import { describe, expect, it } from "vitest";
import { buildEgoNetwork, layoutEgoNetwork } from "./ego-network.js";
import type { LinkRow, PageRow } from "@link-graph/db";

function page(id: number, path: string): PageRow {
  return {
    id,
    crawlId: 1,
    urlNormalized: `https://example.com${path}`,
    path,
    postType: null,
    statusCode: 200,
    depth: 0,
    inTruthSource: true,
    indexable: true,
    canonicalTo: null,
    redirectTo: null,
    class: "linked",
  };
}

function link(id: number, overrides: Partial<LinkRow>): LinkRow {
  return {
    id,
    crawlId: 1,
    fromPageId: 1,
    toUrlNormalized: "https://example.com/",
    toPageId: null,
    anchor: "",
    rel: null,
    isExternal: false,
    isBoilerplate: false,
    container: "main",
    domIndex: 0,
    ...overrides,
  };
}

describe("buildEgoNetwork", () => {
  // 1 (center) -> 2 -> 3 -> 4, and 5 -> 1 (an inbound hop-1 edge).
  const pages = [1, 2, 3, 4, 5].map((id) => page(id, `/p${id}/`));
  const links = [
    link(1, { fromPageId: 1, toPageId: 2 }),
    link(2, { fromPageId: 2, toPageId: 3 }),
    link(3, { fromPageId: 3, toPageId: 4 }),
    link(4, { fromPageId: 5, toPageId: 1 }),
  ];

  it("refuses a center page that is not in this crawl", () => {
    expect(() => buildEgoNetwork(pages, links, 999)).toThrow(/no page 999/);
  });

  it("includes the center, its direct neighbours, and their neighbours", () => {
    const network = buildEgoNetwork(pages, links, 1);
    const hopOf = (id: number) => network.nodes.find((n) => n.pageId === id)?.hop;
    expect(hopOf(1)).toBe(0);
    expect(hopOf(2)).toBe(1); // outbound
    expect(hopOf(5)).toBe(1); // inbound
    expect(hopOf(3)).toBe(2);
    expect(network.nodes.map((n) => n.pageId).sort()).toEqual([1, 2, 3, 5]);
    // Page 4 is three hops from the center and must not appear.
    expect(hopOf(4)).toBeUndefined();
    expect(network.truncated).toBe(false);
  });

  it("excludes external links, self-links, and unresolved targets", () => {
    const noisy = [
      ...links,
      link(5, { fromPageId: 1, toPageId: 2, isExternal: true }),
      link(6, { fromPageId: 1, toPageId: 1 }),
      link(7, { fromPageId: 1, toPageId: null }),
    ];
    const network = buildEgoNetwork(pages, noisy, 1);
    // Same neighbourhood as the clean case: the noisy links contribute nothing new.
    expect(network.nodes.map((n) => n.pageId).sort()).toEqual([1, 2, 3, 5]);
  });

  it("dedupes parallel edges between the same two pages", () => {
    const parallel = [
      link(1, { fromPageId: 1, toPageId: 2 }),
      link(2, { fromPageId: 1, toPageId: 2 }),
      link(3, { fromPageId: 1, toPageId: 2 }),
    ];
    const network = buildEgoNetwork(pages, parallel, 1);
    expect(network.edges).toEqual([{ from: 1, to: 2 }]);
  });

  it("follows only outbound edges when direction is out", () => {
    // 1 -> 2 (outbound from center), 5 -> 1 (inbound to center).
    const network = buildEgoNetwork(pages, links, 1, "out");
    expect(network.nodes.map((n) => n.pageId).sort()).toEqual([1, 2, 3]);
  });

  it("follows only inbound edges when direction is in", () => {
    const network = buildEgoNetwork(pages, links, 1, "in");
    expect(network.nodes.map((n) => n.pageId).sort()).toEqual([1, 5]);
  });

  it("stops at hop 1 when maxHops is 1", () => {
    const network = buildEgoNetwork(pages, links, 1, "both", 1);
    expect(network.nodes.map((n) => n.pageId).sort()).toEqual([1, 2, 5]);
  });

  it("drops peer edges between two nodes at the same hop", () => {
    // 2 and 5 are both hop-1 neighbours of the center; a link between them is a
    // sibling edge that never touches the center and should not be drawn.
    const withPeerLink = [...links, link(8, { fromPageId: 2, toPageId: 5 })];
    const network = buildEgoNetwork(pages, withPeerLink, 1, "both", 1);
    expect(network.edges).not.toContainEqual({ from: 2, to: 5 });
  });

  it("keeps the center and every hop-1 node, trimming only hop-2 to stay near 50", () => {
    // Center linked to 20 hop-1 pages, each of which links to 5 more hop-2 pages —
    // 20 + 100 hop-2 candidates, far over the cap.
    const manyPages = [page(0, "/center/")];
    const manyLinks: LinkRow[] = [];
    let linkId = 0;
    let nextId = 1;
    const hop1Ids: number[] = [];
    for (let i = 0; i < 20; i++) {
      const hop1Id = nextId++;
      hop1Ids.push(hop1Id);
      manyPages.push(page(hop1Id, `/h1-${hop1Id}/`));
      manyLinks.push(link(linkId++, { fromPageId: 0, toPageId: hop1Id }));
      for (let j = 0; j < 5; j++) {
        const hop2Id = nextId++;
        manyPages.push(page(hop2Id, `/h2-${hop2Id}/`));
        manyLinks.push(link(linkId++, { fromPageId: hop1Id, toPageId: hop2Id }));
      }
    }

    const network = buildEgoNetwork(manyPages, manyLinks, 0);
    expect(network.truncated).toBe(true);
    expect(network.nodes.length).toBeLessThanOrEqual(50);
    const hops = new Map(network.nodes.map((n) => [n.pageId, n.hop]));
    expect(hops.get(0)).toBe(0);
    for (const id of hop1Ids) expect(hops.get(id)).toBe(1);
  });
});

describe("layoutEgoNetwork", () => {
  it("places the center at the middle and spaces each ring's nodes evenly", () => {
    const pages = [page(1, "/"), page(2, "/a/"), page(3, "/b/")];
    const links = [
      link(1, { fromPageId: 1, toPageId: 2 }),
      link(2, { fromPageId: 1, toPageId: 3 }),
    ];
    const network = buildEgoNetwork(pages, links, 1);
    const positioned = layoutEgoNetwork(network, 400, 400);

    const center = positioned.find((n) => n.pageId === 1)!;
    expect(center.x).toBe(200);
    expect(center.y).toBe(200);

    const ring = positioned.filter((n) => n.hop === 1);
    expect(ring).toHaveLength(2);
    for (const node of ring) {
      const distance = Math.hypot(node.x - 200, node.y - 200);
      expect(distance).toBeCloseTo(400 * 0.28, 5);
    }
  });
});
