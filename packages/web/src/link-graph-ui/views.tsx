import {useMemo,useState} from 'react';
import {ArrowRight,Compass} from 'lucide-react';
import {useFixture} from './components/fixture-context';
import type {Page} from './data/sampleData';
function sectionName(page:Page){const parts=page.path.split('/').filter(Boolean);return parts.length?'/'+parts[0]+'/':'/';}
function EmptyState({title,body}:{title:string;body:string}){return <div className="empty-state"><div className="empty-mark"><Compass size={18}/></div><h3>{title}</h3><p>{body}</p></div>;}
export function Treemap() {
  const { pages } = useFixture();
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(50);
  const groups = new Map<string, number>();
  pages.forEach((page) => { const key = sectionName(page); groups.set(key, (groups.get(key) ?? 0) + 1); });
  const sorted = [...groups.entries()].filter(([key]) => key.toLowerCase().includes(search.toLowerCase())).sort((a, b) => b[1] - a[1]);
  return <>
    <div className="view-heading"><div><h2>URL hierarchy</h2><p>Pages grouped by the first path segment. Tile size reflects page count in each group.</p></div><span className="mono">{sorted.length} {sorted.length === 1 ? 'section' : 'sections'}</span></div>
    {groups.size > 50 && <label className="page-search">Search sections<input type="search" value={search} onChange={event => { setSearch(event.target.value); setLimit(50); }} /></label>}
    <div className="panel tree-wrap">{pages.length ? <><div className="tree-crumb">SITE ROOT <ArrowRight size={10} style={{ display: 'inline', verticalAlign: 'middle' }} /> PATH GROUPS · {Math.min(limit, sorted.length)} of {sorted.length} matching sections</div><div className="treemap">{sorted.slice(0, limit).map(([path, count], index) => <div key={path} className={`tree-tile ${index === 0 && count > 1 ? 'large' : ''}`} style={{ flexGrow: count }} data-testid={`tile-section-${encodeURIComponent(path)}`}><div className="tree-path">{path}</div><div><div className="tree-count">{count}</div><div className="tree-label">{count === 1 ? 'page record' : 'page records'}</div></div></div>)}</div>{sorted.length > limit && <button className="network-action" onClick={() => setLimit(limit + 50)}>Show 50 more sections</button>}<div style={{ paddingTop: 16, color: '#555555', fontSize: 10 }}>Each tile groups page records with the same leading URL segment. All page rows contribute to the counts.</div></> : <EmptyState title="No URL paths to map yet" body="No page records exist in this capture." />}</div>
  </>;
}

function DistributionCard({ title, note, rows }: { title: string; note: string; rows: [string, number][] }) {
  const max = Math.max(1, ...rows.map((row) => row[1]));
  return <div className="panel chart-panel"><div className="section-title"><h2>{title}</h2><span className="mono" style={{ color: '#555555' }}>{rows.length} groups</span></div><p style={{ color: '#555555', fontSize: 10, margin: '-5px 0 17px' }}>{note}</p>{rows.length ? rows.map(([label, count]) => <div className="chart-row" key={label} data-testid={`distribution-${title.toLowerCase().replaceAll(' ', '-')}-${label}`}><span className="chart-label">{label}</span><div className="chart-track"><span style={{ width: `${Math.max(2, (count / max) * 100)}%` }} /></div><span className="chart-count">{count}</span></div>) : <EmptyState title="No distribution available" body="Page rows from the fixture will populate this view." />}</div>;
}

export function Distributions() {
  const { pages } = useFixture();
  const depth = new Map<string, number>();
  const inbound = new Map<string, number>();
  pages.forEach((page) => { const depthKey = page.depth === null ? 'No path from root' : `Depth ${page.depth}`; depth.set(depthKey, (depth.get(depthKey) ?? 0) + 1); const linksKey = `${page.inboundCount} inbound`; inbound.set(linksKey, (inbound.get(linksKey) ?? 0) + 1); });
  const depthRows = [...depth].sort((a, b) => {
    if (a[0] === 'No path from root') return 1;
    if (b[0] === 'No path from root') return -1;
    return Number(a[0].slice(6)) - Number(b[0].slice(6));
  });
  const inboundRows = [...inbound].sort((a, b) => Number(a[0].split(' ')[0]) - Number(b[0].split(' ')[0]));
  return <>
    <div className="view-heading"><div><h2>Page depth &amp; links</h2><p>Understand how many steps from the entry point and how inbound links are spread.</p></div><span className="mono">{pages.length} page rows</span></div>
    <div className="distribution-grid"><DistributionCard title="Page depth" note="Number of pages at each recorded depth." rows={depthRows} /><DistributionCard title="Inbound links" note="Number of pages with each recorded inbound-link count." rows={inboundRows} /></div>
    <div className="panel panel-pad" style={{ marginTop: 17 }}><div className="section-title"><h2>Read the pattern</h2><span className="mono" style={{ color: '#555555' }}>RECORDED PAGE VALUES</span></div><p style={{ color: '#555555', fontSize: 11, lineHeight: 1.65, margin: 0 }}>A page's depth describes its distance in the captured link structure. Inbound links count internal pages that link to it. The charts summarize page rows; they do not estimate missing crawl data.</p></div>
  </>;
}

export function Matrix() {
  const { pages, links } = useFixture();
  const [search, setSearch] = useState('');
  const [rowPage, setRowPage] = useState(0);
  const [columnPage, setColumnPage] = useState(0);
  const allNames = useMemo(() => [...new Set(pages.map(sectionName))].sort((a, b) => a.localeCompare(b)), [pages]);
  const names = allNames.filter(name => name.toLowerCase().includes(search.toLowerCase()));
  const { counts, internalLinks } = useMemo(() => {
    const pageMap = new Map(pages.map(page => [page.url, page]));
    const counts = new Map<string, number>();
    let internalLinks = 0;
    links.forEach(link => {
      if (link.isExternal || link.isBoilerplate !== false) return;
      const from = pageMap.get(link.fromUrl), to = pageMap.get(link.toUrl);
      if (!from || !to || from.url === to.url) return;
      const key = `${sectionName(from)}|${sectionName(to)}`, n = link.count ?? 1;
      counts.set(key, (counts.get(key) ?? 0) + n); internalLinks += n;
    });
    return { counts, internalLinks };
  }, [pages, links]);
  const rowNames = names.slice(rowPage * 20, rowPage * 20 + 20);
  const columnNames = names.slice(columnPage * 20, columnPage * 20 + 20);
  return <>
    <div className="view-heading"><div><h2>Section relationships</h2><p>Contextual internal links between captured URL sections; repeated header and footer links are excluded.</p></div><span className="mono">{internalLinks} contextual links</span></div>
    {allNames.length > 20 && <div className="graph-expansion"><label className="page-search">Search sections<input type="search" value={search} onChange={event => { setSearch(event.target.value); setRowPage(0); setColumnPage(0); }} /></label><div className="graph-expansion-actions"><button className="network-action" disabled={!rowPage} onClick={() => setRowPage(rowPage - 1)}>Previous rows</button><span>Rows {rowPage * 20 + 1}–{Math.min((rowPage + 1) * 20, names.length)} of {names.length}</span><button className="network-action" disabled={(rowPage + 1) * 20 >= names.length} onClick={() => setRowPage(rowPage + 1)}>Next rows</button><button className="network-action" disabled={!columnPage} onClick={() => setColumnPage(columnPage - 1)}>Previous columns</button><span>Columns {columnPage * 20 + 1}–{Math.min((columnPage + 1) * 20, names.length)}</span><button className="network-action" disabled={(columnPage + 1) * 20 >= names.length} onClick={() => setColumnPage(columnPage + 1)}>Next columns</button></div></div>}
    <div className="panel matrix-scroll">{names.length ? <table className="matrix"><thead><tr><th>From section ↓ &nbsp; To section →</th>{columnNames.map((name) => <th key={name}>{name}</th>)}</tr></thead><tbody>{rowNames.map((from) => <tr key={from}><td>{from}</td>{columnNames.map((to) => { const value = counts.get(`${from}|${to}`) ?? 0; return <td key={to}>{value ? <span className="matrix-cell" data-testid={`matrix-${encodeURIComponent(from)}-${encodeURIComponent(to)}`}>{value}</span> : <span style={{ color: '#D1D1D1' }}>·</span>}</td>; })}</tr>)}</tbody></table> : <EmptyState title="No sections to compare" body="No matching page sections in this capture." />}</div>
    <div style={{ color: '#555555', fontSize: 10, lineHeight: 1.55, marginTop: 12 }}>Only contextual links whose source and destination map to captured pages are included. Repeated boilerplate and self-links are excluded.</div>
  </>;
}
