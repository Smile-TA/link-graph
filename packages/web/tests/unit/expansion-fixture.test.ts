import { describe, expect, it } from 'vitest';
import { createDataset } from '../fixtures/dataset.mjs';
import { addExpansionCaptures, expansionShapes } from '../fixtures/dense-memory.mjs';
import { getEgoNetwork } from '@workspace/link-graph-ui/data/egoNetwork';

describe('expansion memory evidence', () => {
  const dataset = addExpansionCaptures(createDataset());
  it.each(expansionShapes)('$id has complete two-ring evidence and expandable detail groups', shape => {
    const { pages, site } = dataset.snapshots[shape.id];
    const internal = dataset.connections[shape.id].map(row => ({
      ...row, fromUrl: pages[row.from].url, toUrl: pages[row.to].url, isExternal: false,
    }));
    const external = dataset.externalBySite[shape.id].map(row => ({ ...row, isExternal: true }));
    const network = getEgoNetwork(pages, [...internal, ...external], pages[0].url, 2, 'all', true);
    expect(pages).toHaveLength(shape.pages);
    expect(internal).toHaveLength(2 * (shape.pages - 1) + 80);
    expect(network.nodes).toHaveLength(shape.pages - 1 + shape.destinations);
    expect(network.nodes.some(node => node.hop === 2 && node.page.isExternal)).toBe(true);
    expect(network.nodes.some(node => node.hop === 2 && !node.page.isExternal)).toBe(true);
    expect(network.links.length).toBe(site.totalLinkRows);
    expect(network.nodes.filter(node => node.page.isExternal)).toHaveLength(shape.destinations);
    expect(network.links.filter(row => row.toUrl === pages[1].url)).toHaveLength(81);
    expect(network.nodes.every(node => new URL(node.page.url).hostname.endsWith('.test'))).toBe(true);
    const detailGroupCount = network.links.reduce((sum, row) => sum
      + Number(row.fromUrl !== pages[0].url) + Number(row.toUrl !== pages[0].url), 0);
    expect(detailGroupCount).toBe(4 * (shape.pages - 1) + 80 - 2 * Math.floor(shape.pages / 2)
      + shape.destinations + Math.floor(shape.destinations / 2));
  });
});
