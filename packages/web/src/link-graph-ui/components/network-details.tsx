import { useState } from 'react';
import type { ReactNode } from 'react';
import type { EgoNode } from '../data/egoNetwork';
import type { Link } from '../data/sampleData';

const PAGE_SIZE = 25;

function EvidenceGroups({ rows, render }: { rows: Link[]; render: (edge: Link) => ReactNode }) {
  const [page, setPage] = useState(0);
  const start = Math.min(page * PAGE_SIZE, Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1) * PAGE_SIZE);
  return <>
    <p className="explorer-note">Link groups {rows.length ? start + 1 : 0}–{Math.min(start + PAGE_SIZE, rows.length)} of {rows.length}</p>
    {rows.slice(start, start + PAGE_SIZE).map((edge, index) => <div key={start + index}>{render(edge)}</div>)}
    {rows.length > PAGE_SIZE && <div>
      <button className="network-action" disabled={!start} onClick={() => setPage(page - 1)}>Previous link groups</button>
      <button className="network-action" disabled={start + PAGE_SIZE >= rows.length} onClick={() => setPage(page + 1)}>Next link groups</button>
    </div>}
  </>;
}

/** Paging bounds DOM only; the complete evidence and exact totals stay active. */
export function NetworkDetails({ nodes, edges, heading, evidence, locate }: {
  nodes: EgoNode[];
  edges: Map<string, Link[]>;
  heading: (node: EgoNode) => ReactNode;
  evidence: (edge: Link) => ReactNode;
  locate: (node: EgoNode) => void;
}) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const term = search.trim().toLowerCase();
  const matching = term ? nodes.filter(node => `${node.page.path} ${node.page.url}`.toLowerCase().includes(term)) : nodes;
  const start = Math.min(page * PAGE_SIZE, Math.max(0, Math.ceil(matching.length / PAGE_SIZE) - 1) * PAGE_SIZE);
  return <div data-detail-total={nodes.length} data-detail-matching={matching.length} data-detail-start={start}>
    <label className="control-label" htmlFor="connection-search">Find connected page or destination</label>
    <div className="external-search-input"><input id="connection-search" type="search" placeholder="Page path or destination URL" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} /></div>
    <p className="explorer-note" role="status">Showing {matching.length ? start + 1 : 0}–{Math.min(start + PAGE_SIZE, matching.length)} of {matching.length} matching connected pages ({nodes.length} total). All evidence remains available; only this page is rendered.</p>
    {matching.slice(start, start + PAGE_SIZE).map(node => <div key={node.page.url} className="link-detail" data-detail-url={node.page.url} data-testid={`link-detail-${encodeURIComponent(node.page.url)}`}>
      {heading(node)}
      <button className="network-action" onClick={() => locate(node)}>Locate in diagram</button>
      <EvidenceGroups rows={edges.get(node.page.url) ?? []} render={evidence} />
    </div>)}
    {!matching.length && <p className="explorer-note">No matching connected pages.</p>}
    {matching.length > PAGE_SIZE && <div>
      <button className="network-action" disabled={!start} onClick={() => setPage(page - 1)}>Previous connected pages</button>
      <button className="network-action" disabled={start + PAGE_SIZE >= matching.length} onClick={() => setPage(page + 1)}>Next connected pages</button>
    </div>}
  </div>;
}
