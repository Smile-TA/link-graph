import { describe, it, expect } from 'vitest';
import { createDataset } from '../fixtures/dataset.mjs';
import { getEgoNetwork, filterExternalDestinations, limitEgoNodes } from '@workspace/link-graph-ui/data/egoNetwork';
import { filterLinksByDirection } from '@workspace/link-graph-ui/data/graphDirections';
import { getGraphEdgeEndpoints } from '@workspace/link-graph-ui/data/graphEdges';
import { searchFocusPages, pageLabel } from '@workspace/link-graph-ui/data/focusPageSearch';
import { filterBrokenLinks, readBrokenLinkFilters, setBrokenLinkFilter, clearBrokenLinkFilters } from '@workspace/link-graph-ui/components/broken-links';

const { fixture, external } = createDataset();
const { pages, links, brokenLinks } = fixture;
const root = pages[0].url;
describe('Captured graph evidence', () => {
  it.each([1, 2] as const)('traverses %i hops without self-loops or mutation', hops => {
    const before = JSON.stringify(fixture);
    const result = getEgoNetwork(pages, links, root, hops, 'all');
    expect(result.nodes.every(node => node.hop <= hops)).toBe(true);
    expect(new Set(result.nodes.map(node => node.page.url)).size).toBe(result.nodes.length);
    expect(result.links.every(edge => edge.fromUrl !== edge.toUrl)).toBe(true);
    expect(JSON.stringify(fixture)).toBe(before);
  });
  it.each(['incoming', 'outgoing'] as const)('preserves %s edge direction and multiplicities', direction => {
    const result = getEgoNetwork(pages, links, root, 1, direction);
    expect(result.links.length).toBeGreaterThan(0);
    expect(result.links.every(edge => direction === 'incoming' ? edge.toUrl === root : edge.fromUrl === root)).toBe(true);
    expect(filterLinksByDirection(links, root, direction)).toEqual(links.filter(edge =>
      direction === 'incoming' ? edge.toUrl === root : edge.fromUrl === root));
  });
  it('preserves shared terminal external evidence when filtering', () => {
    const result = getEgoNetwork(pages, [...links, ...external.map(row => ({ ...row, isExternal: true }))], root, 2, 'all', true);
    const filtered = filterExternalDestinations(result, ' VIDEO.TEST/watch ');
    expect(filtered.externalCounts).toMatchObject({ totalDestinations: 2, matchingDestinations: 1, totalRows: 7, matchingRows: 6 });
    expect(filtered.nodes.filter(node => !node.page.isExternal)).toEqual(result.nodes.filter(node => !node.page.isExternal));
    expect(filtered.links.filter(row => !row.isExternal)).toEqual(result.links.filter(row => !row.isExternal));
    expect(limitEgoNodes(result.nodes, 2).filter(node => !node.page.isExternal)).toHaveLength(2);
    expect(filterExternalDestinations(result, 'absent.test').externalCounts.matchingDestinations).toBe(0);
  });
  it('handles absent focus and empty captures', () => {
    expect(getEgoNetwork([], [], root, 2, 'all').nodes).toEqual([]);
    expect(getEgoNetwork(pages, links, 'https://absent.test/', 1, 'all').links).toEqual([]);
  });
  it('counts all 5,000 external destinations and repeated source evidence before rendering limits', () => {
    const dense = Array.from({ length: 5000 }, (_, i) => ({
      toUrl: `https://service${i % 10}.test/item/${i}`, anchor: 'service', container: 'main',
      isExternal: true, isBoilerplate: false,
    })).flatMap(row => [
      { ...row, fromUrl: root, count: 1 },
      { ...row, fromUrl: pages[1].url, count: 2 },
    ]);
    for (const direction of ['all', 'outgoing'] as const) {
      const graph = getEgoNetwork(pages, [...links, ...dense], root, 2, direction, true);
      const filtered = filterExternalDestinations(graph, 'SERVICE9.TEST');
      expect(filtered.externalCounts).toMatchObject({
        totalDestinations: 5000, matchingDestinations: 500,
        totalDomains: 10, matchingDomains: 1, matchingRows: 1500,
      });
      expect(filterExternalDestinations(graph, '/item/4999').externalCounts.matchingDestinations).toBe(1);
      const shown = limitEgoNodes(filtered.nodes, 8);
      expect(shown.filter(node => node.page.isExternal)).toHaveLength(8);
      expect(filtered.externalCounts.matchingRows).toBe(1500);
    }
  });
  it('does not traverse through external nodes or count out-of-neighborhood source evidence', () => {
    const target = external[0].toUrl;
    const outside = fixture.pages.find(page => page.path === '/private/')!.url;
    const graph = getEgoNetwork(pages, [
      ...links, ...external.map(row => ({ ...row, isExternal: true })),
      { ...external[0], fromUrl: target, toUrl: outside, isExternal: true },
      { ...external[0], fromUrl: outside, count: 100, isExternal: true },
    ], root, 2, 'outgoing', true);
    expect(graph.nodes.some(node => node.page.url === outside)).toBe(false);
    expect(filterExternalDestinations(graph, 'video.test').externalCounts.matchingRows).toBe(6);
  });
  it('keeps arrow coordinates finite for coincident and separated cards', () => {
    const a = { x: 100, y: 100, width: 150, height: 100 };
    for (const b of [a, { ...a, x: 400 }, { ...a, y: -100 }]) {
      expect(Object.values(getGraphEdgeEndpoints(a, b)).every(Number.isFinite)).toBe(true);
    }
  });
});
describe('Full-dataset search and broken-link filter URLs', () => {
  it('searches path, title, URL, Home alias, and beyond initial options', () => {
    expect(pageLabel('/')).toBe('Home');
    for (const q of ['Home', 'alpha.test/section-63', ' TITLE /SECTION-63/ ']) {
      expect(searchFocusPages(pages, q)).toHaveLength(1);
    }
    expect(searchFocusPages(pages, 'not-present')).toEqual([]);
    expect(searchFocusPages(pages, '')).toHaveLength(pages.length);
  });
  it('finds the last page in a 60,450-page capture without limiting matching counts', () => {
    const large = Array.from({ length: 60_450 }, (_, i) => ({
      ...pages[1], path: `/page-${i}/`, url: `https://large.test/page-${i}/`, title: `Page ${i}`,
    }));
    expect(searchFocusPages(large, '/page-60449/')).toEqual([large.at(-1)]);
    expect(searchFocusPages(large, 'page-')).toHaveLength(60_450);
  });
  it('combines source, destination and status without classifying unresolved targets', () => {
    expect(filterBrokenLinks(brokenLinks, 'ALPHA.TEST/guide', 'gone-', '500')).toHaveLength(15);
    expect(filterBrokenLinks(brokenLinks, '', 'unresolved', '')).toEqual([]);
  });
  it('round-trips filters without deleting unrelated network parameters', () => {
    let params = new URLSearchParams('path=%2F&hops=2&external=1');
    params = setBrokenLinkFilter(params, 'status', '404');
    expect(readBrokenLinkFilters(params).status).toBe('404');
    const cleared = clearBrokenLinkFilters(params);
    expect(cleared.get('hops')).toBe('2');
    expect(cleared.get('external')).toBe('1');
    expect(cleared.has('brokenStatus')).toBe(false);
  });
});
