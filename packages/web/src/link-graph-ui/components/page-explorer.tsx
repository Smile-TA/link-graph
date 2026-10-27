import { useState } from 'react';
import { Link } from 'wouter';
import { Network, Search } from 'lucide-react';
import { useFixture } from './fixture-context';

export function PageExplorer() {
  const { pages, sitePath, site, source } = useFixture();
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(12);
  const matches = pages.filter(page => `${page.path} ${page.title}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="panel page-explorer" aria-label={`All pages for ${site.host}`}>
    <div className="finding-panel-head page-explorer-head">
      <div><h2 className="explorer-title">{source === 'database' ? 'All page records' : 'All captured pages'}</h2><p className="explorer-note">Open any page’s ego network to inspect its incoming and outgoing links.</p></div>
      <label className="page-search"><Search size={14} /><span className="sr-only">Search pages</span><input type="search" placeholder="Search path or title…" value={search} onChange={event => { setSearch(event.target.value); setLimit(12); }} /></label>
    </div>
    <div className="explorer-result-count">{matches.length} of {pages.length} pages</div>
    {matches.slice(0, limit).map(page => <div className="explorer-row" key={page.url}>
      <div className="explorer-page"><Link className="site-link" href={`${sitePath}/ego?path=${encodeURIComponent(page.path)}`}>{page.path}</Link><div className="finding-title">{page.title}</div><span className="explorer-note">{page.inboundCount} inbound · {page.outboundCount} outbound{(source === 'database' ? page.pageClass === 'orphan' : page.inboundCount === 0) ? ' · Orphan page' : ''}{source === 'database' && !page.statusCode ? ' · HTTP unverified' : ''}</span></div>
      <Link className="network-action" href={`${sitePath}/ego?path=${encodeURIComponent(page.path)}`} aria-label={`View page network for ${page.path}`}><Network size={14} /> View page network</Link>
    </div>)}
    {!matches.length && <p className="panel-pad explorer-note">No pages match “{search}”. Try another path or title.</p>}
    {matches.length > limit && <button className="network-action load-pages" onClick={() => setLimit(limit + 12)}>Show more pages ({matches.length - limit} remaining)</button>}
  </section>;
}
