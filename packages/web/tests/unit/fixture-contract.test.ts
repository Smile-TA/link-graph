import { expect, it } from 'vitest';
import { createDataset } from '../fixtures/dataset.mjs';

it('keeps synthetic capture identities and API totals internally consistent', () => {
  const data = createDataset();
  for (const site of data.sites) {
    const snapshot = data.snapshots[site.siteId as keyof typeof data.snapshots];
    expect(snapshot.site.captureVersion).toBe(site.captureVersion);
    expect(snapshot.pages.length).toBe(site.pageCount);
    expect(snapshot.brokenLinks.length).toBe(site.brokenLinks);
    expect(snapshot.edges).toEqual([]);
    if (site.orphanCount !== null) {
      expect(snapshot.pages.filter(page => page.pageClass === 'orphan').length).toBe(site.orphanCount);
    }
    expect(new Set(snapshot.pages.map(page => page.url)).size).toBe(snapshot.pages.length);
  }
});
