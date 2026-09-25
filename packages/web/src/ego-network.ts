/**
 * PRD §9 item 5 — the ego network: one page, its immediate neighbourhood, node-link.
 *
 * **Why this is the one place node-link earns its keep.** §9 rules out a full-site
 * node-link graph as the front page: global nav makes nearly every page link to nearly
 * every other, so past a few hundred nodes the layout is a hairball. Centered on one
 * page and capped to 1-2 hops, the same layout stays readable — this is a drill-down
 * from a specific finding (an orphan, a broken link), not a way to see the whole site.
 */
import type { LinkRow, PageClass, PageRow } from "@link-graph/db";

/** ~50 nodes (PRD §9): past this, hop-2 candidates are dropped, deterministically. */
const MAX_NODES = 50;

/**
 * Which edges count as "a neighbour" while walking outward from the centre.
 * `"out"` follows only edges the centre (and then each further node) points along —
 * "what does this page lead to" — `"in"` follows only edges pointing back — "what
 * leads here" — and `"both"` (the default) follows either, which is also why an
 * inbound-only neighbour like a footer link can otherwise look like it points the
 * wrong way at a glance: the edges themselves are still drawn with arrowheads.
 */
export type EgoDirection = "both" | "out" | "in";

export interface EgoNode {
  readonly pageId: number;
  readonly path: string;
  readonly class: PageClass | null;
  /** 0 = the centre page itself, 1 = a direct neighbour, 2 = a neighbour's neighbour. */
  readonly hop: 0 | 1 | 2;
}

export interface EgoEdge {
  readonly from: number;
  readonly to: number;
}

export interface EgoNetwork {
  readonly nodes: readonly EgoNode[];
  readonly edges: readonly EgoEdge[];
  /** True when hop-2 candidates were cut to stay at `MAX_NODES`. */
  readonly truncated: boolean;
}

/**
 * The centre page's 1- and 2-hop neighbourhood, over internal edges only (an external
 * link has no page to draw) and excluding self-links (a page cannot be its own
 * neighbour). Unlike the section matrix, boilerplate edges are kept: a reader drilling
 * into one specific page wants to see everything that links to and from it, not a
 * contextual subset — the aggregate-vs-single-page distinction the section matrix's own
 * note draws the other way.
 */
export function buildEgoNetwork(
  pages: readonly PageRow[],
  links: readonly LinkRow[],
  centerPageId: number,
  direction: EgoDirection = "both",
  maxHops: 1 | 2 = 2,
): EgoNetwork {
  const pageById = new Map(pages.map((page) => [page.id, page]));
  if (!pageById.has(centerPageId)) {
    throw new Error(`ego network: no page ${centerPageId} in this crawl`);
  }

  const internal = links.filter(
    (link) =>
      !link.isExternal && link.toPageId !== null && link.fromPageId !== link.toPageId,
  );
  // The direction filter applies to which nodes count as neighbours while walking
  // outward — not to which edges are later drawn between the nodes that made it in
  // (every edge among them is still shown, arrowhead and all).
  const neighborsOf = (pageId: number): Set<number> => {
    const neighbors = new Set<number>();
    for (const link of internal) {
      if (direction !== "in" && link.fromPageId === pageId) {
        neighbors.add(link.toPageId as number);
      }
      if (direction !== "out" && link.toPageId === pageId) neighbors.add(link.fromPageId);
    }
    return neighbors;
  };

  const hop1 = neighborsOf(centerPageId);
  const hop2 = new Set<number>();
  if (maxHops === 2) {
    for (const id of hop1) {
      for (const neighbor of neighborsOf(id)) {
        if (neighbor !== centerPageId && !hop1.has(neighbor)) hop2.add(neighbor);
      }
    }
  }

  // Center and every hop-1 node are always kept — the neighbourhood the reader actually
  // asked about — and only hop-2 (context around that neighbourhood) is ever trimmed.
  const orderedHop1 = [...hop1].sort((a, b) => a - b);
  const orderedHop2 = [...hop2].sort((a, b) => a - b);
  const budget = Math.max(0, MAX_NODES - 1 - orderedHop1.length);
  const keptHop2 = orderedHop2.slice(0, budget);
  const truncated = keptHop2.length < orderedHop2.length;

  const hopOf = new Map<number, 0 | 1 | 2>([
    [centerPageId, 0],
    ...orderedHop1.map((id): [number, 1] => [id, 1]),
    ...keptHop2.map((id): [number, 2] => [id, 2]),
  ]);

  const nodes: EgoNode[] = [...hopOf.entries()].map(([pageId, hop]) => {
    const page = pageById.get(pageId);
    if (page === undefined)
      throw new Error(`ego network: link targets unknown page ${pageId}`);
    return { pageId, path: page.path, class: page.class, hop };
  });

  const edgeKeys = new Set<string>();
  const edges: EgoEdge[] = [];
  for (const link of internal) {
    if (!hopOf.has(link.fromPageId) || !hopOf.has(link.toPageId as number)) continue;
    const key = `${link.fromPageId}->${link.toPageId as number}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push({ from: link.fromPageId, to: link.toPageId as number });
  }

  return { nodes, edges, truncated };
}

export interface PositionedEgoNode extends EgoNode {
  readonly x: number;
  readonly y: number;
}

/**
 * Concentric rings, one per hop — the center at the middle, hop-1 nodes spaced evenly
 * around it, hop-2 further out. No force simulation: at ~50 nodes a fixed layout is
 * simpler, deterministic across renders, and exactly as legible.
 */
export function layoutEgoNetwork(
  network: EgoNetwork,
  width: number,
  height: number,
): PositionedEgoNode[] {
  const cx = width / 2;
  const cy = height / 2;
  const radiusByHop: Record<1 | 2, number> = {
    1: Math.min(width, height) * 0.28,
    2: Math.min(width, height) * 0.46,
  };

  const byHop: Record<0 | 1 | 2, EgoNode[]> = { 0: [], 1: [], 2: [] };
  for (const node of network.nodes) byHop[node.hop].push(node);

  const positioned: PositionedEgoNode[] = byHop[0].map((node) => ({
    ...node,
    x: cx,
    y: cy,
  }));
  for (const hop of [1, 2] as const) {
    const ring = byHop[hop];
    const radius = radiusByHop[hop];
    ring.forEach((node, index) => {
      const angle = (2 * Math.PI * index) / ring.length - Math.PI / 2;
      positioned.push({
        ...node,
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
      });
    });
  }
  return positioned;
}
