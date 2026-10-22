import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { GraphEdge, GraphSnapshot } from '@workspace/api-client-react';
import type { Site, Link } from '@workspace/link-graph-ui/data/sampleData';
import type { Fixture } from '@workspace/link-graph-ui/data/fixtureRegistry';
import { FixtureProvider } from '@workspace/link-graph-ui/components/fixture-context';
import { TooltipProvider } from './ui/tooltip';
import { Router as WouterRouter } from 'wouter';
import type { ReactNode } from 'react';
import { ErrorBoundary, type ErrorFallbackProps } from './error-boundary';

type ViewKey = 'findings' | 'pages' | 'ego' | 'treemap' | 'distributions' | 'section-matrix';
type SiteMetadata = {
  siteId: string;
  host: string;
  latestCrawlAt?: string | null;
  pageCount: number;
  orphanCount: number | null;
  unresolvedInternalLinks: number;
  brokenLinks: number;
  sampleLabel: string;
  crawlId?: string | null;
  captureVersion?: string;
  crawlStatus?: string;
  orphanUnknownReason?: string | null;
  enabled?: boolean;
};
type Props = { site: SiteMetadata; view: ViewKey; dataUrl: string; children?: ReactNode };

const queryClient = new QueryClient({
  defaultOptions: { queries: { gcTime: Infinity, staleTime: Infinity, refetchOnWindowFocus: false, retry: 1 } },
});

const PageExplorer = lazy(() => import('@workspace/link-graph-ui/components/page-explorer').then(module => ({ default: module.PageExplorer })));
const BrokenLinks = lazy(() => import('@workspace/link-graph-ui/components/broken-links').then(module => ({ default: module.BrokenLinks })));
const OrphanReviews = lazy(() => import('@workspace/link-graph-ui/components/orphan-reviews').then(module => ({ default: module.OrphanReviews })));
const EgoNetwork = lazy(() => import('@workspace/link-graph-ui/components/ego-network').then(module => ({ default: module.EgoNetwork })));
const Treemap = lazy(() => import('@workspace/link-graph-ui/views').then(module => ({ default: module.Treemap })));
const Distributions = lazy(() => import('@workspace/link-graph-ui/views').then(module => ({ default: module.Distributions })));
const Matrix = lazy(() => import('@workspace/link-graph-ui/views').then(module => ({ default: module.Matrix })));

function useAstroLocation(): [string, (to: string, options?: { replace?: boolean }) => void] {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  const current = () => {
    if (typeof window === 'undefined') return '/';
    return window.location.pathname;
  };
  const [revision, setRevision] = useState(() => ({ pathname: current(), tick: 0 }));
  useEffect(() => {
    const update = () => setRevision(old => ({ pathname: current(), tick: old.tick + 1 }));
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  const navigate = (to: string, options?: { replace?: boolean }) => {
    const target = new URL(to, window.location.href);
    if (target.origin === window.location.origin && base && target.pathname !== base && !target.pathname.startsWith(`${base}/`)) {
      target.pathname = `${base}${target.pathname.startsWith('/') ? '' : '/'}${target.pathname}`;
    }
    if (target.pathname !== current()) {
      window.location.assign(target.href);
      return;
    }
    const next = `${target.pathname}${target.search}${target.hash}`;
    if (options?.replace) window.history.replaceState({}, '', next);
    else window.history.pushState({}, '', next);
    setRevision(old => ({ pathname: current(), tick: old.tick + 1 }));
  };
  void revision.tick;
  return [revision.pathname, navigate];
}

function edgesToLinks(edges: GraphEdge[], pages: GraphSnapshot['pages']): Link[] {
  return edges.map(edge => {
    const from = pages[edge.from];
    const to = pages[edge.to];
    if (!from || !to) throw new Error('The captured connection data references a missing page.');
    return {
      fromUrl: from.url,
      toUrl: to.url,
      anchor: edge.anchor,
      container: edge.container,
      isBoilerplate: edge.isBoilerplate,
      isExternal: false,
      count: edge.count,
    };
  });
}

function LoadingMessage({ error, retry }: { error?: boolean; retry?: () => void }) {
  return <div className={error ? 'native-error' : 'panel panel-pad'} role={error ? 'alert' : 'status'}>
    <strong>{error ? 'Unable to load captured page data' : 'Preparing interactive capture tools…'}</strong>
    <p>{error ? 'The static snapshot could not be read. The evidence below remains available; retry to enable interactive review.' : 'Loading the prerendered capture for search, filters, and local review actions.'}</p>
    {retry && <button className="network-action" type="button" onClick={retry}>Retry loading data</button>}
  </div>;
}

function WidgetFailure({ error, resetError }: ErrorFallbackProps & { children?: ReactNode }) {
  return <div className="native-error" role="alert">
    <strong>The interactive tools could not be opened.</strong>
    <p>The static evidence remains available below. {error.message}</p>
    <button className="network-action" type="button" onClick={resetError}>Retry interactive view</button>
  </div>;
}

function LoadedView({ site, view, snapshot, links }: { site: SiteMetadata; view: ViewKey; snapshot: GraphSnapshot; links: Link[] }) {
  const fixture = useMemo<Fixture>(() => ({
    site: site as Site,
    pages: snapshot.pages,
    links,
    source: 'database',
    description: snapshot.description,
    brokenLinks: snapshot.brokenLinks,
  }), [site, snapshot, links]);
  const content = view === 'findings'
    ? <><BrokenLinks rows={fixture.brokenLinks} /><div className="findings-grid findings-jump-target" id="orphan-pages"><OrphanReviews key={site.siteId} /><aside><div className="panel side-card"><p className="eyebrow">How to read this</p><h3>Find a way in</h3><p>An orphan page has no incoming internal links in the captured site graph. Review whether it should be discoverable from a relevant page.</p></div><div className="panel side-card"><p className="eyebrow">Scope note</p><h3>Recorded link evidence</h3><p>Unresolved internal targets are unverified, not broken. Only captured HTTP failures are listed as broken links. No new link checks are performed.</p></div></aside></div></>
    : view === 'pages' ? <PageExplorer key={site.siteId} />
    : view === 'ego' ? <EgoNetwork />
    : view === 'treemap' ? <Treemap />
    : view === 'distributions' ? <Distributions />
    : <Matrix />;
  return <FixtureProvider fixture={fixture}>{content}</FixtureProvider>;
}

function InteractiveBody({ site, view, dataUrl, children }: Props) {
  const queryKey = ['astro-capture', site.siteId, site.captureVersion ?? site.crawlId ?? 'capture'];
  const snapshotQuery = useQuery<GraphSnapshot>({
    queryKey,
    queryFn: async () => {
      const url = new URL(dataUrl, window.location.href);
      url.searchParams.set('capture', site.captureVersion ?? site.crawlId ?? 'none');
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`Snapshot request failed (${response.status}).`);
      const snapshot: GraphSnapshot = await response.json();
      if (snapshot.site.siteId !== site.siteId || snapshot.site.crawlId !== site.crawlId ||
          snapshot.site.captureVersion !== site.captureVersion) {
        throw new Error('The static capture changed. Reload this page to use the regenerated version.');
      }
      return snapshot;
    },
    enabled: typeof window !== 'undefined',
  });
  const needsConnections = view === 'ego' || view === 'section-matrix';
  const connectionKey = ['link-graph-connections', site.siteId, site.crawlId, site.captureVersion ?? site.crawlId];
  const connectionsQuery = useQuery<GraphEdge[]>({
    queryKey: connectionKey,
    queryFn: async () => {
      const { getLinkGraphConnections } = await import('@workspace/api-client-react');
      return getLinkGraphConnections(site.siteId, site.crawlId ?? '0');
    },
    enabled: !!snapshotQuery.data && needsConnections && !!site.crawlId,
  });
  const snapshot = snapshotQuery.data;
  const sourceEdges = needsConnections && connectionsQuery.data ? connectionsQuery.data : snapshot?.edges ?? [];
  const links = useMemo(() => snapshot ? edgesToLinks(sourceEdges, snapshot.pages) : [], [sourceEdges, snapshot?.pages]);
  if (snapshotQuery.isError) return <><LoadingMessage error retry={() => void snapshotQuery.refetch()} />{children}</>;
  if (!snapshot) return <>{children}</>;
  if (needsConnections && site.crawlId && connectionsQuery.isError) return <><LoadingMessage error retry={() => void connectionsQuery.refetch()} />{children}</>;
  if (needsConnections && site.crawlId && !connectionsQuery.data) return <><LoadingMessage />{children}</>;
  return <ErrorBoundary resetKey={view} FallbackComponent={props => <><WidgetFailure {...props} />{children}</>}>
    <Suspense fallback={children}><LoadedView site={site} view={view} snapshot={snapshot} links={links} /></Suspense>
  </ErrorBoundary>;
}

export default function InteractiveView(props: Props) {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  return <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <WouterRouter base={base} hook={useAstroLocation}>
        <InteractiveBody {...props} />
      </WouterRouter>
    </TooltipProvider>
  </QueryClientProvider>;
}
