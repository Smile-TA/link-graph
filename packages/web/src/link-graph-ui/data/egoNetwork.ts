import type { Link, Page } from './sampleData';
import type { LinkDirection } from './graphDirections';

export interface EgoNode {
  page: Page;
  hop: number;
  parentUrl: string;
}

export function balanceExternalNodes(nodes: EgoNode[]) {
  const internal = nodes.filter(node => !node.page.isExternal);
  const external = nodes.filter(node => node.page.isExternal);
  const balanced: EgoNode[] = [];
  for (let i = 0; i < Math.max(internal.length, external.length); i++) {
    if (internal[i]) balanced.push(internal[i]);
    if (external[i]) balanced.push(external[i]);
  }
  return balanced;
}

/** External evidence can add terminal nodes, but never inferred external adjacency. */
export function getEgoNetwork(pages: Page[], links: Link[], focusUrl: string, hops: 1 | 2, direction: LinkDirection, showExternal = false) {
  const pageMap = new Map(pages.map(page => [page.url, page]));
  if (showExternal) {
    for (const link of links) {
      if (!link.isExternal || !pageMap.has(link.fromUrl) || pageMap.get(link.fromUrl)?.isExternal || pageMap.has(link.toUrl)) continue;
      pageMap.set(link.toUrl, {
        url: link.toUrl, path: link.toUrl, title: link.toUrl, statusCode: null,
        pageClass: 'external', depth: null, indexable: false, inboundCount: 0, outboundCount: 0, isExternal: true,
      });
    }
  }
  const eligible = links.filter(link => (showExternal || !link.isExternal) && link.fromUrl !== link.toUrl && pageMap.has(link.fromUrl) && !pageMap.get(link.fromUrl)?.isExternal && pageMap.has(link.toUrl));
  const distances = new Map<string, number>();
  const adjacent = new Map<string, string[]>();
  function add(from: string, to: string) {
    const row = adjacent.get(from);
    if (row) row.push(to); else adjacent.set(from, [to]);
  }
  eligible.forEach(link => {
    if (direction !== 'incoming') add(link.fromUrl, link.toUrl);
    if (direction !== 'outgoing') add(link.toUrl, link.fromUrl);
  });
  const nodes: EgoNode[] = [];
  if (!pageMap.has(focusUrl) || pageMap.get(focusUrl)?.isExternal) return { nodes, links: [] as Link[], distances };
  distances.set(focusUrl, 0);
  const queue = [focusUrl];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i], depth = distances.get(current)!;
    if (depth >= hops || pageMap.get(current)?.isExternal) continue;
    for (const neighbor of adjacent.get(current) ?? []) {
      if (distances.has(neighbor)) continue;
      distances.set(neighbor, depth + 1);
      nodes.push({ page: pageMap.get(neighbor)!, hop: depth + 1, parentUrl: current });
      queue.push(neighbor);
    }
  }
  const selectedLinks = eligible.filter(link => {
    const from = distances.get(link.fromUrl), to = distances.get(link.toUrl);
    if (from === undefined || to === undefined) return false;
    // Preserve shared-destination evidence even from boundary source pages.
    if (link.isExternal) return direction !== 'incoming';
    if (hops === 1 && from !== 0 && to !== 0) return false;
    return direction === 'all' || (direction === 'outgoing' ? from < to : from > to);
  });
  return { nodes: showExternal ? [...balanceExternalNodes(nodes.filter(node => node.hop === 1)),
    ...balanceExternalNodes(nodes.filter(node => node.hop === 2))] : nodes, links: selectedLinks, distances };
}

type Network = ReturnType<typeof getEgoNetwork>;

/** Filter terminal destinations after traversal, never the captured-page network. */
export function filterExternalDestinations(network: Network, search: string) {
  const term = search.trim().toLowerCase();
  const external = network.nodes.filter(node => node.page.isExternal);
  const externalUrls = new Set(external.map(node => node.page.url));
  const matches = external.filter(node => node.page.url.toLowerCase().includes(term));
  const matchingUrls = new Set(matches.map(node => node.page.url));
  const nodes = network.nodes.filter(node => !node.page.isExternal || matchingUrls.has(node.page.url));
  const links = network.links.filter(edge => !edge.isExternal || matchingUrls.has(edge.toUrl));
  const domains = (rows: EgoNode[]) => new Set(rows.flatMap(node => {
    try { const host = new URL(node.page.url).hostname.toLowerCase(); return host ? [host] : []; }
    catch { return []; }
  })).size;
  const rowCount = (rows: Link[]) => rows.reduce((sum, edge) => sum + (edge.isExternal ? edge.count ?? 1 : 0), 0);
  return {
    ...network, nodes, links,
    distances: new Map([...network.distances].filter(([url]) =>
      !externalUrls.has(url) || matchingUrls.has(url))),
    externalCounts: {
      totalDestinations: external.length, matchingDestinations: matches.length,
      totalDomains: domains(external), matchingDomains: domains(matches),
      totalRows: rowCount(network.links), matchingRows: rowCount(links),
    },
  };
}

const isBrokenNode = (node: EgoNode) => !node.page.isExternal && (node.page.statusCode ?? 0) >= 400;

/**
 * Separate per-kind budgets keep external evidence from replacing internal context. Within
 * the internal budget, pages that answer HTTP 4xx/5xx come first: a broken destination is
 * the node the reader most needs to see, and must not sit behind a "show more" button.
 */
export function limitEgoNodes(nodes: EgoNode[], limit: number) {
  const internal = nodes.filter(node => !node.page.isExternal);
  return balanceExternalNodes([
    ...[...internal.filter(isBrokenNode), ...internal.filter(node => !isBrokenNode(node))].slice(0, limit),
    ...nodes.filter(node => node.page.isExternal).slice(0, limit),
  ]);
}
