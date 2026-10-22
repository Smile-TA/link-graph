import { Link, useLocation, useSearch } from 'wouter';
import { useState } from 'react';
import { AlertTriangle, Network, RotateCcw } from 'lucide-react';
import type { BrokenLink } from '.././data/fixtureRegistry';
import { useFixture } from './fixture-context';

function path(url: string) { return new URL(url).pathname; }

const PAGE_SIZE = 25;
const FILTER_PARAMS = {
  source: 'brokenSource',
  destination: 'brokenDestination',
  status: 'brokenStatus',
} as const;

export function readBrokenLinkFilters(params: URLSearchParams) {
  return {
    source: params.get(FILTER_PARAMS.source) ?? '',
    destination: params.get(FILTER_PARAMS.destination) ?? '',
    status: params.get(FILTER_PARAMS.status) ?? '',
  };
}

export function setBrokenLinkFilter(params: URLSearchParams, filter: keyof typeof FILTER_PARAMS, value: string) {
  const next = new URLSearchParams(params);
  if (value) next.set(FILTER_PARAMS[filter], value);
  else next.delete(FILTER_PARAMS[filter]);
  return next;
}

export function clearBrokenLinkFilters(params: URLSearchParams) {
  const next = new URLSearchParams(params);
  Object.values(FILTER_PARAMS).forEach(key => next.delete(key));
  return next;
}

export function filterBrokenLinks(rows: BrokenLink[], sourceQuery: string, destinationQuery: string, status: string) {
  const source = sourceQuery.trim().toLocaleLowerCase();
  const destination = destinationQuery.trim().toLocaleLowerCase();
  return rows.filter(row =>
    (!source || row.fromUrl.toLocaleLowerCase().includes(source)) &&
    (!destination || row.toUrl.toLocaleLowerCase().includes(destination)) &&
    (!status || String(row.statusCode) === status),
  );
}

export function BrokenLinks({ rows, network = false, hrefForPage }: {
  rows: BrokenLink[];
  network?: boolean;
  hrefForPage?: (path: string) => string;
}) {
  const { sitePath, source, site } = useFixture();
  const [location, navigate] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const { source: sourceQuery, destination: destinationQuery, status } = readBrokenLinkFilters(params);
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);
  const href = hrefForPage ?? ((path: string) => `${sitePath}/ego?path=${encodeURIComponent(path)}`);
  const filteredRows = filterBrokenLinks(rows, sourceQuery, destinationQuery, status);
  const visibleRows = filteredRows.slice(0, visibleLimit);
  const filtersActive = Boolean(sourceQuery.trim() || destinationQuery.trim() || status);
  const statuses = [...new Set(rows.map(row => row.statusCode))].sort((a, b) => a - b);
  function updateFilter(filter: keyof typeof FILTER_PARAMS, value: string) {
    const next = setBrokenLinkFilter(params, filter, value);
    navigate(`${location}${next.size ? `?${next.toString()}` : ''}`, { replace: true });
    setVisibleLimit(PAGE_SIZE);
  }
  function clearFilters() {
    const next = clearBrokenLinkFilters(params);
    navigate(`${location}${next.size ? `?${next.toString()}` : ''}`, { replace: true });
    setVisibleLimit(PAGE_SIZE);
  }

  return <section className="panel broken-links-panel" aria-label={network ? 'Broken links in this network' : 'Site broken links'}>
    <div className="finding-panel-head">
      <div><h2 className="explorer-title"><AlertTriangle size={15} /> {network ? 'Broken links in this network' : 'Broken links'}</h2><p className="explorer-note">{source === 'synthetic' ? 'Synthetic test cases · generated HTTP failures, not real crawl results.' : 'Verified HTTP failures only. Unresolved targets are not counted as broken.'}</p></div>
      <span className={filteredRows.length ? 'broken-count' : 'mono'} data-testid={network ? 'network-broken-count' : 'site-broken-count'}>{filtersActive ? `${filteredRows.length} of ${rows.length} matching` : `${rows.length} verified`} {rows.length === 1 && !filtersActive ? 'link' : 'links'}</span>
    </div>
    {rows.length > 0 && <div className="broken-filter-bar" aria-label="Filter verified broken links">
      <label>Source URL<input type="search" value={sourceQuery} onChange={event => updateFilter('source', event.target.value)} placeholder="Search source URL" aria-label="Search source URL" data-testid="broken-source-search" /></label>
      <label>Destination URL<input type="search" value={destinationQuery} onChange={event => updateFilter('destination', event.target.value)} placeholder="Search destination URL" aria-label="Search destination URL" data-testid="broken-destination-search" /></label>
      <label>HTTP status<select value={status} onChange={event => updateFilter('status', event.target.value)} aria-label="Filter by HTTP status" data-testid="broken-status-filter"><option value="">All statuses</option>{statuses.map(code => <option key={code} value={code}>HTTP {code}</option>)}</select></label>
      {filtersActive && <button type="button" className="network-action broken-clear-filters" onClick={clearFilters} data-testid="clear-broken-filters"><RotateCcw size={12} /> Clear filters</button>}
    </div>}
    {filteredRows.length > 0 ? <>
      <div className="broken-table-scroll"><table className="broken-table"><thead><tr><th>Source page</th><th>Broken destination</th><th>Status</th><th>Inspect</th></tr></thead><tbody>{visibleRows.map((row, i) => <tr key={`${row.fromUrl}:${row.toUrl}:${i}`}>
        <td><Link className="site-link" href={href(path(row.fromUrl))}>{path(row.fromUrl)}</Link><div className="explorer-note">{row.anchor || 'No anchor text'}</div></td>
        <td><span className="broken-url">{row.toUrl}</span></td>
        <td><span className="http-error">HTTP {row.statusCode} · verified</span></td>
        <td><Link className="network-action" href={href(path(row.fromUrl))} aria-label={`View network containing broken link from ${path(row.fromUrl)}`}><Network size={13} /> View network</Link></td>
      </tr>)}</tbody></table></div>
      {visibleRows.length < filteredRows.length && <div className="broken-pagination"><span className="explorer-note">Showing {visibleRows.length} of {filteredRows.length} matching links</span><button type="button" className="network-action" onClick={() => setVisibleLimit(limit => limit + PAGE_SIZE)} data-testid="load-more-broken-links">Load 25 more</button></div>}
    </> : <div className="broken-empty" role="status">{rows.length > 0 ? <>No verified broken links match these filters. <button type="button" className="broken-inline-clear" onClick={clearFilters} data-testid="clear-broken-filters-empty">Clear filters</button></> : network ? 'No verified broken links in the selected neighborhood and network scope.' : source === 'database' ? 'No verified broken links in this capture.' : 'No verified broken links in this fixture.'}</div>}
    {!network && site.unresolvedInternalLinks > 0 && <p className="broken-unresolved" role="note"><strong>Unresolved internal targets:</strong> {site.unresolvedInternalLinks} site-wide. Their HTTP status is unverified, so they are not listed as broken links.</p>}
  </section>;
}
