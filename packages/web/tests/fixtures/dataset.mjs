// Reserved .test domains only. These are synthetic test records, never live data.
export function createDataset() {
  const origin = 'https://alpha.test';
  const page = (path, overrides = {}) => ({
    url: `${origin}${path}`, path, title: path === '/' ? 'Alpha home' : `Title ${path}`,
    statusCode: 200, pageClass: 'linked', depth: 1, indexable: true,
    inboundCount: 1, outboundCount: 1, postType: null, inTruthSource: false, ...overrides,
  });
  const pages = [
    page('/', { depth: 0 }),
    page('/guide/'), page('/contact/'), page('/missing/', { statusCode: 404 }),
    page('/private/', { pageClass: 'orphan', depth: null, inboundCount: 0 }),
    ...Array.from({ length: 64 }, (_, i) => page(`/section-${String(i).padStart(2, '0')}/entry/`)),
    ...Array.from({ length: 28 }, (_, i) => page(`/orphan-${i}/`, {
      pageClass: 'orphan', depth: null, inboundCount: 0,
    })),
    page('/encoded space/'), page('/unverified/', { statusCode: null }),
  ];
  const edge = (from, to, count = 1, isBoilerplate = false) => ({
    from, to, anchor: `edge-${from}-${to}`, container: 'main', isBoilerplate, count,
  });
  const edges = [
    edge(0, 1, 3), edge(1, 2, 2), edge(2, 0), edge(0, 3), edge(1, 3),
    edge(0, 0), edge(0, 2, 10, true),
    ...Array.from({ length: 64 }, (_, i) => edge(0, i + 5)),
  ];
  const external = [
    { fromUrl: pages[0].url, toUrl: 'https://video.test/watch/demo', anchor: 'video', container: 'main', isBoilerplate: false, count: 4 },
    { fromUrl: pages[1].url, toUrl: 'https://video.test/watch/demo', anchor: 'shared video', container: 'main', isBoilerplate: false, count: 2 },
    { fromUrl: pages[0].url, toUrl: 'https://docs.test/manual', anchor: 'manual', container: 'main', isBoilerplate: false, count: 1 },
  ];
  const brokenLinks = Array.from({ length: 31 }, (_, i) => ({
    fromUrl: pages[i % 2].url,
    toUrl: i === 0 ? pages[3].url : `${origin}/gone-${i}/`,
    statusCode: i % 2 ? 500 : 404, anchor: `Broken ${i}`,
  }));
  const site = {
    siteId: 'alpha', host: 'alpha.test', latestCrawlAt: '2026-10-01T10:00:00.000Z',
    pageCount: pages.length, orphanCount: 29, unresolvedInternalLinks: 7,
    brokenLinks: brokenLinks.length, externalDestinations: 2,
    totalLinkRows: edges.reduce((n, row) => n + row.count, 0) + 7,
    sampleLabel: 'Synthetic UI test capture', crawlId: 'test-alpha',
    captureVersion: 'ui-test-alpha-v1', crawlStatus: 'complete',
    orphanUnknownReason: null, enabled: true,
  };
  const beta = {
    ...site, siteId: 'beta', host: 'beta.test', crawlId: 'test-beta',
    captureVersion: 'ui-test-beta-v1', pageCount: 1, orphanCount: null,
    orphanUnknownReason: 'No recorded orphan classification', unresolvedInternalLinks: 0,
    brokenLinks: 0, externalDestinations: 0, totalLinkRows: 0, enabled: false,
    latestCrawlAt: '',
  };
  const empty = {
    ...beta, siteId: 'empty', host: 'empty.test', crawlId: 'test-empty',
    captureVersion: 'ui-test-empty-v1', pageCount: 0, orphanCount: 0, enabled: true,
  };
  const snapshots = {
    alpha: { site, pages, edges: [], brokenLinks, source: 'database', description: 'Synthetic test evidence only.' },
    beta: { site: beta, pages: [{ ...page('/'), url: 'https://beta.test/' }], edges: [], brokenLinks: [], source: 'database', description: 'Synthetic unknown-metric test.' },
    empty: { site: empty, pages: [], edges: [], brokenLinks: [], source: 'database', description: 'Synthetic empty capture.' },
  };
  const links = edges.map(row => ({
    fromUrl: pages[row.from].url, toUrl: pages[row.to].url, anchor: row.anchor,
    container: row.container, isBoilerplate: row.isBoilerplate, count: row.count, isExternal: false,
  }));
  return { sites: [site, beta, empty], snapshots, edges, external, fixture: {
    site, pages, links, brokenLinks, source: 'database', description: 'Synthetic component fixture.',
  } };
}
