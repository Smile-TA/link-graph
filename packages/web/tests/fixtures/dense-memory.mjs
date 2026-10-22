// Separate from normal UI fixtures so the regular regression build stays small.
export const denseShape = { pages: 6000, edges: 23996, destinations: 5000, externalRows: 10000 };

export function addDenseCaptures(dataset) {
  dataset.connections = { alpha: dataset.edges };
  dataset.externalBySite = { alpha: dataset.external };
  for (const id of ['dense-a', 'dense-b']) {
    const origin = `https://${id}.test`;
    const pages = Array.from({ length: denseShape.pages }, (_, i) => ({
      url: `${origin}${i ? `/page-${i}/` : '/'}`,
      path: i ? `/page-${i}/` : '/', title: i ? `Dense page ${i}` : 'Dense home',
      statusCode: 200, pageClass: 'linked', depth: i ? 1 : 0, indexable: true,
      inboundCount: 4, outboundCount: 4, postType: null, inTruthSource: false,
    }));
    const edges = pages.slice(1).flatMap((_, index) => {
      const i = index + 1;
      return [0, i, i, i].map((from, j) => ({
        from, to: j === 0 ? i : j === 1 ? 0 : (i + j) % pages.length,
        anchor: `dense-${i}-${j}`, container: 'main', isBoilerplate: false, count: 1,
      }));
    });
    const external = Array.from({ length: denseShape.destinations }, (_, i) =>
      [0, i + 1].map(from => ({
        fromUrl: pages[from].url, toUrl: `https://service-${i % 10}.test/item-${i}/`,
        anchor: `external-${i}-${from}`, container: 'main', isBoilerplate: false, count: 1,
      }))).flat();
    const site = {
      ...dataset.sites[0], siteId: id, host: `${id}.test`, pageCount: pages.length,
      orphanCount: 0, brokenLinks: 0, unresolvedInternalLinks: 0,
      externalDestinations: denseShape.destinations, totalLinkRows: edges.length + external.length,
      crawlId: `test-${id}`, captureVersion: `memory-${id}-v1`,
      sampleLabel: 'Synthetic dense memory capture',
    };
    dataset.sites.push(site);
    dataset.snapshots[id] = { site, pages, edges: [], brokenLinks: [], source: 'database', description: 'Deterministic memory evidence; never imported data.' };
    dataset.connections[id] = edges;
    dataset.externalBySite[id] = external;
  }
  return dataset;
}

// Separate opt-in expansion captures: include both rings and a high-degree
// non-root page so "more link groups" is exercised as well as "more pages".
export const expansionShapes = [
  { id: 'expand-small', pages: 1500, destinations: 1000 },
  { id: 'expand-baseline', pages: 6000, destinations: 5000 },
  { id: 'expand-large', pages: 8000, destinations: 7000 },
];

export function addExpansionCaptures(dataset) {
  dataset.connections = { alpha: dataset.edges };
  dataset.externalBySite = { alpha: dataset.external };
  for (const shape of expansionShapes) {
    const { id, pages: count, destinations } = shape;
    const origin = `https://${id}.test`;
    const pages = Array.from({ length: count }, (_, i) => ({
      url: `${origin}${i ? `/page-${i}/` : '/'}`, path: i ? `/page-${i}/` : '/',
      title: `Synthetic expansion page ${i}`, statusCode: 200, pageClass: 'linked',
      depth: i ? 1 : 0, indexable: true, inboundCount: 2, outboundCount: 2,
      postType: null, inTruthSource: false,
    }));
    const directCount = Math.floor(count / 2);
    const edges = pages.slice(1).flatMap((_, index) => {
      const i = index + 1;
      const parent = i <= directCount ? 0 : 1 + (i % directCount);
      return [
        { from: parent, to: i, anchor: `to-${i}`, container: 'main', isBoilerplate: false, count: 1 },
        { from: i, to: parent, anchor: `back-${i}`, container: 'main', isBoilerplate: false, count: 1 },
      ];
    });
    // 80 distinct evidence groups on page 1, without adding new neighbors.
    for (let i = 0; i < 80; i++) edges.push({
      from: 0, to: 1, anchor: `hub-evidence-${i}`, container: 'main', isBoilerplate: false, count: 1,
    });
    const external = Array.from({ length: destinations }, (_, i) => ({
      fromUrl: pages[i % 2 ? 1 + (i % directCount) : 0].url,
      toUrl: `https://expansion-service-${i % 10}.test/item-${i}/`,
      anchor: `external-${i}`, container: 'main', isBoilerplate: false, count: 1,
    }));
    const site = {
      ...dataset.sites[0], siteId: id, host: `${id}.test`, pageCount: count,
      orphanCount: 0, brokenLinks: 0, unresolvedInternalLinks: 0,
      externalDestinations: destinations, totalLinkRows: edges.length + external.length,
      crawlId: `test-${id}`, captureVersion: `expansion-${id}-v1`,
      sampleLabel: 'Synthetic expansion memory capture',
    };
    dataset.sites.push(site);
    dataset.snapshots[id] = { site, pages, edges: [], brokenLinks: [], source: 'database', description: 'Deterministic expansion workload; not imported data.' };
    dataset.connections[id] = edges;
    dataset.externalBySite[id] = external;
  }
  return dataset;
}
