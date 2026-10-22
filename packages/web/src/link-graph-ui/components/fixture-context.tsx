import { createContext, useContext, type ReactNode } from 'react';
import type { Fixture } from '../data/fixtureRegistry';

const FixtureContext = createContext<Fixture | null>(null);
export function FixtureProvider({ fixture, children }: { fixture: Fixture; children: ReactNode }) {
  return <FixtureContext.Provider value={fixture}>{children}</FixtureContext.Provider>;
}
export function useFixture() {
  const fixture = useContext(FixtureContext);
  if (!fixture) throw new Error('A captured site is required for this view.');
  return { ...fixture, sitePath: `/sites/${fixture.site.siteId}` };
}
export function useOptionalFixture() { return useContext(FixtureContext); }
export function getSections(siteId: string) {
  const base = `/sites/${siteId}`;
  return [
    { key: 'findings', href: base, label: 'Findings' },
    { key: 'ego', href: `${base}/ego?path=%2F`, label: 'Page network' },
    { key: 'pages', href: `${base}/pages`, label: 'All page records' },
    { key: 'treemap', href: `${base}/treemap`, label: 'URL hierarchy' },
    { key: 'distributions', href: `${base}/distributions`, label: 'Distributions' },
    { key: 'section-matrix', href: `${base}/section-matrix`, label: 'Section matrix' },
  ];
}
