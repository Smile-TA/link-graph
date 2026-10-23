import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { ArrowLeft, ExternalLink, GripHorizontal, Minus, Plus, RotateCcw } from 'lucide-react';
import { useGetLinkGraphExternalLinks, getGetLinkGraphExternalLinksQueryKey } from '@workspace/api-client-react';
import type { Link as GraphLink } from '.././data/sampleData';
import { Switch } from './ui/switch';
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force';
import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force';
import { getEgoNetwork, filterExternalDestinations, limitEgoNodes } from '.././data/egoNetwork';
import type { LinkDirection } from '.././data/graphDirections';
import { getGraphLayout } from '.././data/graphLayout';
import { getGraphEdgeEndpoints } from '.././data/graphEdges';
import { BrokenLinks } from './broken-links';
import { useFixture } from './fixture-context';
import { FocusPagePicker } from './focus-page-picker';
import { pageLabel } from '.././data/focusPageSearch';
import { NetworkDetails } from './network-details';

interface GraphSimulationNode extends SimulationNodeDatum {
  id: string;
  hop: number;
}

interface GraphSimulationLink extends SimulationLinkDatum<GraphSimulationNode> {}

function ExternalDestinationLink({ url, className }: { url: string; className?: string }) {
  let href: string | undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') href = url;
  } catch { /* Unsupported destinations stay readable, never executable links. */ }
  return href ? <a href={href} className={className} target="_blank" rel="noopener noreferrer" draggable={false}
    aria-label={`External destination ${url} (opens in a new tab)`}>{url} <ExternalLink size={11} aria-hidden="true" /></a>
    : <span className={className}>{url}</span>;
}

const hasHttpFailure = (status: number | null) => status !== null && status >= 400;

interface ActiveGraphDrag {
  nodeId: string;
  pointerId: number | null;
  offsetX: number;
  offsetY: number;
  startX: number;
  startY: number;
  startClientX: number;
  startClientY: number;
  moved: boolean;
  mode: 'pointer' | 'keyboard';
}

export function EgoNetwork() {
  const [expansion, setExpansion] = useState<{ key: string; direct: number; second: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
   const [pendingExpansion, setPendingExpansion] = useState<(() => void) | null>(null);
   const [viewport, setViewport] = useState({ left: 0, top: 0, width: 1000, height: 600 });
   const [locateUrl, setLocateUrl] = useState<string | null>(null);
  const [highlightUrl, setHighlightUrl] = useState<string | null>(null);
  const graphScrollRef = useRef<HTMLDivElement>(null);
  const graphSceneRef = useRef<HTMLDivElement>(null);
  const layoutPositionsRef = useRef(new Map<string, { x: number; y: number }>());
  const pinnedPositionsRef = useRef(new Map<string, { x: number; y: number }>());
  const simulationRef = useRef<Simulation<GraphSimulationNode, undefined> | null>(null);
  const simulationNodesRef = useRef<GraphSimulationNode[]>([]);
  const simulationLinksRef = useRef<GraphSimulationLink[]>([]);
  const graphNodeElementsRef = useRef(new Map<string, HTMLElement>());
  const graphEdgeElementsRef = useRef<SVGLineElement[]>([]);
   const nodeSizesRef = useRef(new Map<string, { width: number; height: number }>());
  const activeDragRef = useRef<ActiveGraphDrag | null>(null);
  const simulationFocusRef = useRef<string | null>(null);
  const { pages, links, brokenLinks, sitePath, site, source } = useFixture();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(useSearch());
  const hops = params.get('hops') === '2' ? 2 : 1;
  const showExternal = params.get('external') === '1';
  const externalSearch = showExternal ? params.get('externalSearch') ?? '' : '';
  const crawlId = site.crawlId ?? '0';
  const externalQuery = useGetLinkGraphExternalLinks(site.siteId, crawlId, undefined, {
    query: { queryKey: [...getGetLinkGraphExternalLinksQueryKey(site.siteId, crawlId), site.captureVersion ?? crawlId],
      enabled: showExternal && source === 'database' && !!site.crawlId,
      staleTime: Infinity, gcTime: typeof window === 'undefined' ? Infinity : 30 * 60_000,
      retry: 1, refetchOnWindowFocus: false },
  });
  const graphLinks = useMemo<GraphLink[]>(() => {
    if (!showExternal || source !== 'database' || !externalQuery.data) return links;
    return [...links, ...externalQuery.data.map(edge => ({ ...edge, isExternal: true }))];
  }, [links, showExternal, source, externalQuery.data]);
  const direction: LinkDirection = params.get('direction') === 'incoming' ? 'incoming' : params.get('direction') === 'outgoing' ? 'outgoing' : 'all';
  const focus = pages.find(page => page.path === (params.get('path') ?? '/'));
  const unfilteredNetworks = useMemo(() => ({
    all: getEgoNetwork(pages, graphLinks, focus?.url ?? '', hops, 'all', showExternal),
    incoming: getEgoNetwork(pages, graphLinks, focus?.url ?? '', hops, 'incoming', showExternal),
    outgoing: getEgoNetwork(pages, graphLinks, focus?.url ?? '', hops, 'outgoing', showExternal),
  }), [pages, graphLinks, focus?.url, hops, showExternal]);
  const networks = useMemo(() => ({
    all: filterExternalDestinations(unfilteredNetworks.all, externalSearch),
    incoming: filterExternalDestinations(unfilteredNetworks.incoming, externalSearch),
    outgoing: filterExternalDestinations(unfilteredNetworks.outgoing, externalSearch),
  }), [unfilteredNetworks, externalSearch]);
  const network = networks[direction];
  const externalReady = source !== 'database' || (!!site.crawlId && !!focus && externalQuery.isSuccess);
  const linkRowCount = (rows: typeof links) => rows.reduce((sum, row) => sum + (row.count ?? 1), 0);
  const detailEdges = useMemo(() => {
    const map = new Map<string, typeof links>();
    network.links.forEach(edge => {
      for (const url of new Set([edge.fromUrl, edge.toUrl])) {
        const row = map.get(url);
        if (row) row.push(edge); else map.set(url, [edge]);
      }
    });
    return map;
  }, [network.links]);
  const expansionKey = `${focus?.url ?? ''}|${hops}|${direction}|${showExternal}|${externalSearch}`;
   useEffect(() => { setPendingExpansion(null); }, [expansionKey]);
  const initialDirectCount = hops === 1 ? 8 : 6;
  const visibleDirectCount = expansion?.key === expansionKey ? expansion.direct : initialDirectCount;
  const visibleSecondCount = expansion?.key === expansionKey ? expansion.second : 8;
  function hrefForPage(path: string) {
    const next = new URLSearchParams(params);
    next.set('path', path);
    return `${sitePath}/ego?${next}`;
  }
  function setOption(key: string, value: string) {
    const next = new URLSearchParams(params);
    next.set(key, value);
    navigate(`${sitePath}/ego?${next}`, { replace: true });
  }
  const capturedPaths = useMemo(() => new Map(pages.map(page => [page.url, page.path])), [pages]);
  function renderEvidenceLink(url: string, external = false) {
    const path = capturedPaths.get(url);
    return !external && path !== undefined
      ? <Link href={hrefForPage(path)}>{pageLabel(path)}</Link>
      : <ExternalDestinationLink url={url} />;
  }

   const allDirect = useMemo(() => network.nodes.filter(node => node.hop === 1), [network.nodes]);
   const direct = useMemo(() => limitEgoNodes(allDirect, visibleDirectCount), [allDirect, visibleDirectCount]);
  const directUrls = new Set(direct.map(node => node.page.url));
  const availableSecond = network.nodes.filter(node => node.hop === 2 && directUrls.has(node.parentUrl));
  const second = limitEgoNodes(availableSecond, visibleSecondCount);
  const moreDirectCount = limitEgoNodes(allDirect, visibleDirectCount + 8).length - direct.length;
  const moreSecondCount = limitEgoNodes(availableSecond, visibleSecondCount + 8).length - second.length;
  const allSecondCount = network.nodes.filter(node => node.hop === 2).length;
  const displayedNodesCount = direct.length + second.length;
  // On zoom-in, grow ring spacing faster than node labels to reduce crowding.
  const { directRadius, secondRadius, sceneSize, zoomSpread } = getGraphLayout(direct.length, second.length, hops, zoom);
   const networkEdgeKeys = useMemo(() => new Set(network.links.map(edge => `${edge.fromUrl}|${edge.toUrl}`)), [network.links]);
   const displayedNodes = [...direct.map((node, i) => ({ node, i })), ...second.map((node, i) => ({ node, i }))].map(({ node, i }) => {
     const ring = node.hop === 1 ? direct : second;
    const angle = (Math.PI * 2 * i) / Math.max(ring.length, 1) - Math.PI / 2 + (node.hop === 2 ? Math.PI / Math.max(ring.length, 1) : 0);
    const radius = node.hop === 1 ? directRadius : secondRadius;
     const outgoing = networkEdgeKeys.has(`${node.parentUrl}|${node.page.url}`);
     const incoming = networkEdgeKeys.has(`${node.page.url}|${node.parentUrl}`);
    return { ...node, outgoing, incoming, x: sceneSize / 2 + Math.cos(angle) * radius, y: sceneSize / 2 + Math.sin(angle) * radius };
  });
  const positions = new Map(displayedNodes.map(node => [node.page.url, { x: node.x, y: node.y }]));
  if (focus) positions.set(focus.url, { x: sceneSize / 2, y: sceneSize / 2 });
  const groups = new Map<string, { from: string; to: string; forward: boolean; backward: boolean; forwardBroken: boolean; backwardBroken: boolean }>();
  const failures = new Set(brokenLinks.map(link => `${link.fromUrl}|${link.toUrl}`));
  network.links.forEach(edge => {
    if (!positions.has(edge.fromUrl) || !positions.has(edge.toUrl)) return;
    const fromDepth = network.distances.get(edge.fromUrl)!, toDepth = network.distances.get(edge.toUrl)!;
    const fromFirst = fromDepth < toDepth || (fromDepth === toDepth && edge.fromUrl.localeCompare(edge.toUrl) < 0);
    const from = fromFirst ? edge.fromUrl : edge.toUrl, to = fromFirst ? edge.toUrl : edge.fromUrl;
    const key = `${from}|${to}`;
    const group = groups.get(key) ?? { from, to, forward: false, backward: false, forwardBroken: false, backwardBroken: false };
    if (fromFirst) { group.forward = true; group.forwardBroken ||= failures.has(`${edge.fromUrl}|${edge.toUrl}`); }
    else { group.backward = true; group.backwardBroken ||= failures.has(`${edge.fromUrl}|${edge.toUrl}`); }
    groups.set(key, group);
  });
  const visibleBroken = brokenLinks.filter(edge => networkEdgeKeys.has(`${edge.fromUrl}|${edge.toUrl}`));
   const windowed = displayedNodesCount > 250;
   const inViewport = (point: { x: number; y: number }) =>
     point.x >= viewport.left - 200 && point.x <= viewport.left + viewport.width + 200 &&
     point.y >= viewport.top - 200 && point.y <= viewport.top + viewport.height + 200;
   const renderedNodes = windowed ? displayedNodes.filter(node => inViewport(pinnedPositionsRef.current.get(node.page.url) ?? node) || node.page.url === draggingNodeId) : displayedNodes;
   useEffect(() => {
     if (!windowed || !graphSceneRef.current) return;
     graphNodeElementsRef.current = new Map([...graphSceneRef.current.querySelectorAll<HTMLElement>('[data-graph-node-id]')].map(element => [element.dataset.graphNodeId!, element]));
     graphEdgeElementsRef.current = [...graphSceneRef.current.querySelectorAll<SVGLineElement>('[data-graph-edge-index]')];
   });
   useEffect(() => {
     const scroll = graphScrollRef.current;
     if (!scroll) return;
     let frame = 0;
     const update = () => {
       cancelAnimationFrame(frame);
       frame = requestAnimationFrame(() => setViewport({
         left: scroll.scrollLeft / zoom, top: scroll.scrollTop / zoom,
         width: scroll.clientWidth / zoom, height: scroll.clientHeight / zoom,
       }));
     };
     const observer = new ResizeObserver(update);
     observer.observe(scroll);
     scroll.addEventListener('scroll', update, { passive: true });
     update();
     return () => { cancelAnimationFrame(frame); observer.disconnect(); scroll.removeEventListener('scroll', update); };
   }, [zoom, !!focus]);
  useEffect(() => {
    const scroll = graphScrollRef.current;
    if (!scroll) return;
    scroll.scrollLeft = (scroll.scrollWidth - scroll.clientWidth) / 2;
    scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) / 2;
  }, [sceneSize, zoom, focus?.url, hops, direction, displayedNodesCount]);
   useEffect(() => {
     if (!locateUrl) return;
     const point = layoutPositionsRef.current.get(locateUrl) ?? positions.get(locateUrl);
     const scroll = graphScrollRef.current;
     if (point && scroll) {
       scroll.scrollLeft = point.x * zoom - scroll.clientWidth / 2;
       scroll.scrollTop = point.y * zoom - scroll.clientHeight / 2;
       setHighlightUrl(locateUrl);
       setLocateUrl(null);
     }
   }, [locateUrl, sceneSize, displayedNodesCount, zoom]);
  useEffect(() => {
    if (!highlightUrl) return;
    const timer = setTimeout(() => setHighlightUrl(null), 3500);
    return () => clearTimeout(timer);
  }, [highlightUrl]);
  const visibleNodeKey = displayedNodes.map(node => node.page.url).join('|');
  const visibleEdgeKey = [...groups.keys()].join('|');
  const updateGraphPositions = () => {
    const center = sceneSize / 2;
    const nodeById = new Map(simulationNodesRef.current.map(node => [node.id, node]));
     const updatedPositions = new Map<string, { x: number; y: number }>();
    for (const node of simulationNodesRef.current) {
      const x = node.x ?? center;
      const y = node.y ?? center;
      updatedPositions.set(node.id, { x, y });
      const element = graphNodeElementsRef.current.get(node.id);
      if (element) {
        element.style.left = `${x}px`;
        element.style.top = `${y}px`;
      }
    }
    layoutPositionsRef.current = updatedPositions;
    const resolveNode = (endpoint: string | number | GraphSimulationNode) =>
      typeof endpoint === 'object' ? endpoint : nodeById.get(String(endpoint));
    simulationLinksRef.current.forEach((link, index) => {
      const source = resolveNode(link.source);
      const target = resolveNode(link.target);
      const element = graphEdgeElementsRef.current[index];
      if (!source || !target || !element) return;
       const sourceSize = nodeSizesRef.current.get(source.id) ?? { width: 150, height: 112 };
       const targetSize = nodeSizesRef.current.get(target.id) ?? { width: 150, height: 112 };
      const endpoints = getGraphEdgeEndpoints(
         { x: source.x ?? center, y: source.y ?? center, ...sourceSize },
         { x: target.x ?? center, y: target.y ?? center, ...targetSize },
      );
      Object.entries(endpoints).forEach(([name, value]) => element.setAttribute(name, String(value)));
    });
  };
  useEffect(() => {
    const scene = graphSceneRef.current;
    if (!scene || !focus) return;

    const nodeElements = new Map(
      [...scene.querySelectorAll<HTMLElement>('[data-graph-node-id]')]
        .map(element => [element.dataset.graphNodeId!, element]),
    );
    const focusElement = scene.querySelector<HTMLElement>('[data-graph-focus-node]');
    if (focusElement) nodeElements.set(focus.url, focusElement);
    const edgeElements = [...scene.querySelectorAll<SVGLineElement>('[data-graph-edge-index]')];
    const center = sceneSize / 2;
    if (simulationFocusRef.current !== focus.url) {
      pinnedPositionsRef.current.delete(focus.url);
      simulationFocusRef.current = focus.url;
    }
    const pinnedFocus = pinnedPositionsRef.current.get(focus.url);
    const simulationNodes: GraphSimulationNode[] = [
      { id: focus.url, hop: 0, x: pinnedFocus?.x ?? center, y: pinnedFocus?.y ?? center, fx: pinnedFocus?.x ?? center, fy: pinnedFocus?.y ?? center },
      ...displayedNodes.map(node => {
        const pinned = pinnedPositionsRef.current.get(node.page.url);
        const previous = layoutPositionsRef.current.get(node.page.url);
        return {
          id: node.page.url,
          hop: node.hop,
           x: pinned?.x ?? (windowed ? node.x : previous?.x ?? node.x),
           y: pinned?.y ?? (windowed ? node.y : previous?.y ?? node.y),
          fx: pinned?.x,
          fy: pinned?.y,
        };
      }),
    ];
    const nodeById = new Map(simulationNodes.map(node => [node.id, node]));
    const resolveNode = (endpoint: string | number | GraphSimulationNode) =>
      typeof endpoint === 'object' ? endpoint : nodeById.get(String(endpoint))!;
    simulationNodesRef.current = simulationNodes;
    graphNodeElementsRef.current = nodeElements;
    graphEdgeElementsRef.current = edgeElements;
     nodeSizesRef.current = new Map([...nodeElements].map(([id, element]) => [id, { width: element.offsetWidth, height: element.offsetHeight }]));
    const simulationLinks: GraphSimulationLink[] = [...groups.values()].map(group => ({
      source: group.from,
      target: group.to,
    }));
    simulationLinksRef.current = simulationLinks;
     // Dense diagrams retain all positions but do not run thousands of bodies
     // on the main thread. Panning mounts only nearby labels.
     if (windowed) {
       layoutPositionsRef.current = new Map(simulationNodes.map(node => [node.id, { x: node.x!, y: node.y! }]));
       return () => {
         simulationNodesRef.current = [];
         simulationLinksRef.current = [];
         graphNodeElementsRef.current.clear();
         graphEdgeElementsRef.current = [];
         nodeSizesRef.current.clear();
       };
     }
     const simulation = forceSimulation(simulationNodes)
      .force('link', forceLink<GraphSimulationNode, GraphSimulationLink>(simulationLinks)
        .id(node => node.id)
        .distance(link => {
          const source = resolveNode(link.source);
          const target = resolveNode(link.target);
          if (source.hop === 0 || target.hop === 0) return directRadius;
          if (source.hop === 1 && target.hop === 1) return Math.max(100, directRadius * .55);
          return Math.max(110, secondRadius - directRadius);
        })
        .strength(.18))
      .force('charge', forceManyBody<GraphSimulationNode>().strength(-70 * zoomSpread).distanceMax(sceneSize * .7))
      .force('collide', forceCollide<GraphSimulationNode>().radius(node => {
         const size = nodeSizesRef.current.get(node.id);
         return (size ? Math.hypot(size.width, size.height) / 2 + 16 : 78) * Math.max(1, zoom);
      }).strength(.7).iterations(2))
      .force('x', forceX<GraphSimulationNode>(center).strength(node => node.hop === 2 ? .0005 : .001))
      .force('y', forceY<GraphSimulationNode>(center).strength(node => node.hop === 2 ? .0005 : .001))
      .alpha(1)
      .alphaDecay(.04)
      .on('tick', updateGraphPositions);
    simulationRef.current = simulation;
    updateGraphPositions();
     const resizeObserver = new ResizeObserver(entries => {
       for (const entry of entries) {
         const element = entry.target as HTMLElement;
         nodeSizesRef.current.set(element.dataset.graphNodeId!, { width: element.offsetWidth, height: element.offsetHeight });
       }
      updateGraphPositions();
      const collision = simulation.force('collide') as ReturnType<typeof forceCollide<GraphSimulationNode>>;
      collision.radius(collision.radius());
      simulation.alpha(.1).restart();
    });
    nodeElements.forEach(element => resizeObserver.observe(element));

    return () => {
      resizeObserver.disconnect();
      simulation.stop();
      if (simulationRef.current === simulation) simulationRef.current = null;
      simulationNodesRef.current = [];
      simulationLinksRef.current = [];
      graphNodeElementsRef.current.clear();
      graphEdgeElementsRef.current = [];
       nodeSizesRef.current.clear();
    };
  }, [visibleNodeKey, visibleEdgeKey, sceneSize, zoom, focus?.url, directRadius, secondRadius, zoomSpread]);
  const scenePoint = (clientX: number, clientY: number) => {
    const rect = graphSceneRef.current?.getBoundingClientRect();
    if (!rect) return { x: sceneSize / 2, y: sceneSize / 2 };
    return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom };
  };
  const moveGraphNode = (nodeId: string, x: number, y: number) => {
    const node = simulationNodesRef.current.find(candidate => candidate.id === nodeId);
    if (!node) return;
    const margin = 76;
    const nextX = Math.max(margin, Math.min(sceneSize - margin, x));
    const nextY = Math.max(margin, Math.min(sceneSize - margin, y));
    node.x = nextX;
    node.y = nextY;
    node.vx = 0;
    node.vy = 0;
    node.fx = nextX;
    node.fy = nextY;
    pinnedPositionsRef.current.set(nodeId, { x: nextX, y: nextY });
    updateGraphPositions();
    simulationRef.current?.alpha(.12).alphaTarget(.12).restart();
  };
  const finishGraphDrag = () => {
    activeDragRef.current = null;
    setDraggingNodeId(null);
    simulationRef.current?.alphaTarget(0).alpha(.025).restart();
  };
  const resetNodePositions = () => {
    const drag = activeDragRef.current;
    activeDragRef.current = null;
    setDraggingNodeId(null);
    if (drag?.pointerId != null) {
      const handle = graphNodeElementsRef.current.get(drag.nodeId)?.querySelector<HTMLElement>('.graph-drag-handle');
      if (handle?.hasPointerCapture(drag.pointerId)) handle.releasePointerCapture(drag.pointerId);
    }
    pinnedPositionsRef.current.clear();
    layoutPositionsRef.current.clear();
    const initialPositions = new Map(displayedNodes.map(node => [node.page.url, node]));
    const center = sceneSize / 2;
    for (const node of simulationNodesRef.current) {
      const initial = initialPositions.get(node.id);
      node.x = initial?.x ?? center;
      node.y = initial?.y ?? center;
      node.vx = 0;
      node.vy = 0;
      node.fx = node.hop === 0 ? center : null;
      node.fy = node.hop === 0 ? center : null;
    }
    updateGraphPositions();
    simulationRef.current?.alphaTarget(0).alpha(1).restart();
  };
  const handleNodePointerDown = (nodeId: string, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    const node = simulationNodesRef.current.find(candidate => candidate.id === nodeId);
    if (!node) return;
    const point = scenePoint(event.clientX, event.clientY);
    const nodeX = node.x ?? point.x;
    const nodeY = node.y ?? point.y;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    activeDragRef.current = {
      nodeId,
      pointerId: event.pointerId,
      offsetX: nodeX - point.x,
      offsetY: nodeY - point.y,
      startX: nodeX,
      startY: nodeY,
      startClientX: event.clientX,
      startClientY: event.clientY,
      moved: false,
      mode: 'pointer',
    };
    setDraggingNodeId(nodeId);
  };
  const handleNodePointerMove = (nodeId: string, event: ReactPointerEvent<HTMLElement>) => {
    const drag = activeDragRef.current;
    if (!drag || drag.nodeId !== nodeId || drag.mode !== 'pointer' || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startClientX;
    const dy = event.clientY - drag.startClientY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    event.preventDefault();
    const point = scenePoint(event.clientX, event.clientY);
    moveGraphNode(drag.nodeId, point.x + drag.offsetX, point.y + drag.offsetY);
  };
  const handleNodePointerEnd = (nodeId: string, event: ReactPointerEvent<HTMLElement>, canceled = false) => {
    const drag = activeDragRef.current;
    if (!drag || drag.nodeId !== nodeId || drag.mode !== 'pointer' || drag.pointerId !== event.pointerId) return;
    const captureTarget = event.currentTarget;
    if (captureTarget.hasPointerCapture?.(event.pointerId)) captureTarget.releasePointerCapture(event.pointerId);
    if (!drag.moved && canceled) {
      moveGraphNode(drag.nodeId, drag.startX, drag.startY);
    }
    finishGraphDrag();
  };
  const handleNodeKeyDown = (nodeId: string, event: ReactKeyboardEvent<HTMLElement>) => {
    const active = activeDragRef.current;
    if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      if (active?.mode === 'keyboard' && active.nodeId === nodeId) {
        finishGraphDrag();
        return;
      }
      if (active) return;
      const node = simulationNodesRef.current.find(candidate => candidate.id === nodeId);
      if (!node) return;
      activeDragRef.current = {
        nodeId,
        pointerId: null,
        offsetX: 0,
        offsetY: 0,
        startX: node.x ?? sceneSize / 2,
        startY: node.y ?? sceneSize / 2,
        startClientX: 0,
        startClientY: 0,
        moved: false,
        mode: 'keyboard',
      };
      setDraggingNodeId(nodeId);
      return;
    }
    if (active?.mode !== 'keyboard' || active.nodeId !== nodeId) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      finishGraphDrag();
      return;
    }
    const step = event.shiftKey ? 50 : 20;
    const moves: Record<string, [number, number]> = {
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    active.moved = true;
    const node = simulationNodesRef.current.find(candidate => candidate.id === nodeId);
    if (node) moveGraphNode(nodeId, (node.x ?? sceneSize / 2) + move[0], (node.y ?? sceneSize / 2) + move[1]);
  };
  const renderDragHandle = (nodeId: string, label: string) => (
    <button
      type="button"
      className="graph-drag-handle"
      data-graph-drag-handle={nodeId}
      aria-label={`Move ${label}`}
      aria-pressed={draggingNodeId === nodeId}
      aria-describedby="graph-move-help"
      aria-keyshortcuts="Space ArrowUp ArrowDown ArrowLeft ArrowRight Escape"
      title="Drag to move; Space and arrow keys to move with the keyboard"
      onPointerDown={event => handleNodePointerDown(nodeId, event)}
      onPointerMove={event => handleNodePointerMove(nodeId, event)}
      onPointerUp={event => handleNodePointerEnd(nodeId, event)}
      onPointerCancel={event => handleNodePointerEnd(nodeId, event, true)}
      onLostPointerCapture={() => {
        if (activeDragRef.current?.nodeId === nodeId && activeDragRef.current.mode === 'pointer') finishGraphDrag();
      }}
      onKeyDown={event => handleNodeKeyDown(nodeId, event)}
      onBlur={() => {
        if (activeDragRef.current?.nodeId === nodeId && activeDragRef.current.mode === 'keyboard') finishGraphDrag();
      }}
    >
      <GripHorizontal size={14} aria-hidden="true" /><span>Move</span>
    </button>
  );
  const updateExpansion = (direct: number, second: number) => setExpansion({ key: expansionKey, direct, second });
  const showMoreDirect = () => updateExpansion(Math.min(allDirect.length, visibleDirectCount + 8), visibleSecondCount);
   const confirmExpansion = (count: number, action: () => void) => {
     if (count > 250) setPendingExpansion(() => action);
     else action();
   };
   const showAllDirect = () => confirmExpansion(allDirect.length + second.length, () => updateExpansion(allDirect.length, visibleSecondCount));
  const showMoreSecond = () => updateExpansion(visibleDirectCount, Math.min(availableSecond.length, visibleSecondCount + 8));
   const showAllSecond = () => confirmExpansion(direct.length + availableSecond.length, () => updateExpansion(visibleDirectCount, availableSecond.length));
  const options = [
    { key: 'all' as const, label: 'All directions' },
    { key: 'incoming' as const, label: 'Incoming' },
    { key: 'outgoing' as const, label: 'Outgoing' },
  ];

  return <>
    <div className="view-heading"><div><h2>Page network <span className="explorer-note">(ego network)</span></h2><p>Explore direct neighbors or expand to two hops. Click any page to refocus.</p></div><Link href={hrefForPage('/')} className="site-link mono"><ArrowLeft size={12} /> Home focus</Link></div>
    <FocusPagePicker pages={pages} focus={focus} onSelect={path => navigate(hrefForPage(path))} />
    <div className="network-toolbar">
      <div><div className="control-label">Depth</div><div className="direction-filter" role="group" aria-label="Network hop depth">{([1, 2] as const).map(value => <button type="button" className={`direction-option ${hops === value ? 'selected' : ''}`} aria-pressed={hops === value} key={value} data-testid={`hop-filter-${value}`} onClick={() => setOption('hops', String(value))}>{value} {value === 1 ? 'hop' : 'hops'}</button>)}</div></div>
      <div><div className="control-label">Link direction</div><div className="direction-filter" role="group" aria-label="Filter network by link direction">{options.map(option => <button type="button" className={`direction-option ${direction === option.key ? 'selected' : ''}`} aria-pressed={direction === option.key} key={option.key} data-testid={`direction-filter-${option.key}`} onClick={() => setOption('direction', option.key)}>{option.label}<span>{linkRowCount(networks[option.key].links)}</span></button>)}</div></div>
      <div><div className="control-label">Destinations</div><label className="external-network-toggle"><Switch checked={showExternal} onCheckedChange={checked => setOption('external', checked ? '1' : '0')} aria-label="Show external links" data-testid="toggle-external-links" />Show external links</label></div>
      {showExternal && <div className="external-network-search"><label className="control-label" htmlFor="external-destination-search">External domain or destination</label><div className="external-search-input"><input id="external-destination-search" type="search" placeholder="e.g. youtube.com or /embed/" value={externalSearch} onChange={event => setOption('externalSearch', event.target.value)} aria-describedby="external-filter-scope" />{externalSearch && <button type="button" className="network-action" onClick={() => setOption('externalSearch', '')}>Clear filter</button>}</div></div>}
    </div>
    {showExternal && <p id="external-filter-scope" className="explorer-note">Case-insensitive text match on the recorded external destination URL, including its domain and path. Only external destinations and their link evidence are filtered; internal pages, connections and captured-page metrics are unchanged. Counts cover this focus, direction and hop depth, before graph or detail-list limits. External row counts include every recorded link from an internal page in this neighborhood to a reachable external destination, including shared destinations. Domain counts use distinct hostnames (subdomains are separate).</p>}
    {showExternal && externalReady && <div className="external-network-status" role="status" data-testid="external-destination-counts">
      <p>{network.externalCounts.matchingDestinations} of {network.externalCounts.totalDestinations} external destinations match · {network.externalCounts.matchingDomains} of {network.externalCounts.totalDomains} domains · {network.externalCounts.matchingRows} of {network.externalCounts.totalRows} recorded external link rows.</p>
       <p>{displayedNodes.filter(node => node.page.isExternal).length} matching external nodes included in graph. Connection details is searchable and paged. Internal and external nodes have separate expansion limits; expand the graph or page through details to see more.</p>
      {network.externalCounts.totalDestinations === 0 ? <p>No recorded external destinations in this network.{direction === 'incoming' ? ' The capture contains outbound evidence only, not inbound links from other sites.' : ''}</p> : network.externalCounts.matchingDestinations === 0 && <p>No external destinations match “{externalSearch}”. Clear the filter to restore them. Internal context remains visible.</p>}
    </div>}
    {showExternal && source === 'database' && site.crawlId && externalQuery.isPending && <p className="external-network-status" role="status">Loading recorded external links… Internal links remain available.</p>}
    {showExternal && externalQuery.isError && <p className="external-network-status" role="alert">External links could not be loaded. No external nodes have been substituted. <button type="button" className="network-action" onClick={() => void externalQuery.refetch()}>Retry external links</button></p>}
    <p className="network-legend">Arrowheads show source → destination. {hops === 2 && 'Inner ring: 1 hop · outer ring: 2 hops. ' }<span className="broken-key">Red marks a verified broken destination.</span></p>
    {showExternal && <p className="network-legend external-network-legend">Dashed nodes are external destinations recorded in this capture. HTTP status is unverified; no external pages are crawled. They are terminal nodes, not connections between captured pages.{direction === 'incoming' && ' Incoming-only shows no external destinations because this capture records outbound external links, not inbound links from other sites.'}</p>}
    {focus ? <>
      <div className="graph-expansion" aria-label="Diagram page display controls">
        <p className="explorer-note" role="status">
          Showing {direct.length} of {allDirect.length} 1-hop pages
          {hops === 2 && ` and ${second.length} of ${allSecondCount} 2-hop pages`}
          {hops === 2 && direct.length < allDirect.length ? ' · Expand 1-hop pages to reveal their 2-hop connections.' : ''}
        </p>
        <div className="graph-expansion-actions">
          {direct.length < allDirect.length && <>
            <button type="button" className="network-action" onClick={showMoreDirect} data-testid="show-more-direct">Show {moreDirectCount} more 1-hop pages</button>
            {allDirect.length - direct.length > moreDirectCount && <button type="button" className="network-action" onClick={showAllDirect} data-testid="show-all-direct">Show all {allDirect.length} 1-hop pages</button>}
          </>}
          {hops === 2 && direct.length === allDirect.length && availableSecond.length > second.length && <>
            <button type="button" className="network-action" onClick={showMoreSecond} data-testid="show-more-second">Show {moreSecondCount} more 2-hop pages</button>
            {availableSecond.length - second.length > moreSecondCount && <button type="button" className="network-action" onClick={showAllSecond} data-testid="show-all-second">Show all {availableSecond.length} available 2-hop pages</button>}
          </>}
        </div>
        {pendingExpansion && <div role="alert" className="external-network-status">
          <p>Expand a large network? This can use substantial memory and take time. Large diagrams use a stable, windowed layout instead of continuous simulation. Only nearby labels are mounted; all nodes, connections and exact counts remain available. Prefer incremental expansion or search on smaller devices.</p>
          <button className="network-action" onClick={() => { pendingExpansion(); setPendingExpansion(null); }}>Continue large expansion</button>
          <button className="network-action" onClick={() => setPendingExpansion(null)}>Cancel expansion</button>
        </div>}
        {windowed && <p className="explorer-note">Windowed diagram: {renderedNodes.length} neighbor labels in the viewport; {displayedNodesCount} included. Pan to see other nodes, or find any page or destination in Connection details and choose Locate in diagram. Connections remain complete. Large diagrams use a stable layout.</p>}
      </div>
      <div className="graph-layout">
        <section className="panel graph-canvas" aria-label={`Focused ${hops}-hop link graph`}>
          <div className="graph-zoom-controls" role="group" aria-label="Diagram zoom controls">
            <button type="button" className="network-action graph-zoom-button" onClick={() => setZoom(value => Math.max(.5, Math.round((value - .25) * 100) / 100))} disabled={zoom <= .5} aria-label="Zoom out"><Minus size={13} /></button>
            <span className="graph-zoom-level" aria-live="polite">{Math.round(zoom * 100)}%</span>
            <label className="graph-zoom-slider-label">Zoom
              <input className="graph-zoom-slider" type="range" min=".5" max="2" step=".05" value={zoom} onChange={event => setZoom(Number(event.target.value))} aria-label="Diagram zoom" data-testid="graph-zoom-slider" />
            </label>
            <button type="button" className="network-action graph-zoom-button" onClick={() => setZoom(value => Math.min(2, Math.round((value + .25) * 100) / 100))} disabled={zoom >= 2} aria-label="Zoom in"><Plus size={13} /></button>
            <button type="button" className="network-action" onClick={() => setZoom(1)} disabled={zoom === 1} aria-label="Reset zoom"><RotateCcw size={12} aria-hidden="true" />Reset zoom</button>
            <button type="button" className="network-action" onClick={resetNodePositions} data-testid="reset-node-positions" title="Restore automatic node positions without changing zoom or filters"><RotateCcw size={12} aria-hidden="true" />Reset positions</button>
          </div>
          <div className="graph-scroll" ref={graphScrollRef} tabIndex={0} aria-label="Scrollable page network diagram; use arrow keys or scroll to pan">
            <div className="graph-zoom-stage" style={{ width: `${sceneSize * zoom}px`, height: `${sceneSize * zoom}px` }}>
            <div className="graph-scene" ref={graphSceneRef} data-graph-total={displayedNodesCount + 1} data-graph-edge-total={groups.size} data-graph-windowed={windowed} style={{ width: `${sceneSize}px`, height: `${sceneSize}px`, transform: `scale(${zoom})` }}>
            <svg className="graph-edge-layer" style={windowed ? { left: viewport.left, top: viewport.top, width: viewport.width, height: viewport.height, overflow: 'hidden' } : undefined} viewBox={windowed ? `${viewport.left} ${viewport.top} ${viewport.width} ${viewport.height}` : `0 0 ${sceneSize} ${sceneSize}`} preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <marker id="edge-out-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0 L10 5 L0 10z" fill="#2763F1" /></marker>
                <marker id="edge-in-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10z" fill="#C09B42" /></marker>
                <marker id="edge-broken-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10z" fill="#b42318" /></marker>
              </defs>
              {hops === 2 && <><circle className="hop-ring" cx={sceneSize / 2} cy={sceneSize / 2} r={directRadius} /><circle className="hop-ring" cx={sceneSize / 2} cy={sceneSize / 2} r={secondRadius} /></>}
              {[...groups.entries()].map(([key, group], index) => {
                const from = (windowed && pinnedPositionsRef.current.get(group.from)) || positions.get(group.from)!;
                const to = (windowed && pinnedPositionsRef.current.get(group.to)) || positions.get(group.to)!;
                return <line key={key} data-graph-edge-index={index} data-graph-from={group.from} data-graph-to={group.to} {...getGraphEdgeEndpoints({ ...from, width: 150, height: 112 }, { ...to, width: 150, height: 112 })} className={`graph-edge ${group.forwardBroken || group.backwardBroken ? 'broken-edge' : ''}`} markerStart={group.backward ? `url(#edge-${group.backwardBroken ? 'broken' : 'in'}-arrow)` : undefined} markerEnd={group.forward ? `url(#edge-${group.forwardBroken ? 'broken' : 'out'}-arrow)` : undefined} />;
              })}
            </svg>
            {renderedNodes.map(node => <div key={node.page.url} data-graph-node-id={node.page.url} data-external={node.page.isExternal || undefined} data-moving={draggingNodeId === node.page.url} className={`graph-node ${highlightUrl === node.page.url ? 'locate-highlight' : ''} ${node.page.isExternal ? 'external-node' : ''} ${node.hop === 2 ? 'second-hop-node' : ''} ${hasHttpFailure(node.page.statusCode) ? 'broken-node' : ''}`} style={{ left: `${(windowed ? pinnedPositionsRef.current.get(node.page.url)?.x : undefined) ?? node.x}px`, top: `${(windowed ? pinnedPositionsRef.current.get(node.page.url)?.y : undefined) ?? node.y}px`, transform: 'translate(-50%,-50%)' }} title={`${node.page.url} · ${node.hop} hop${node.hop === 2 ? 's' : ''}`}>
              {node.page.isExternal ? <ExternalDestinationLink url={node.page.url} className="graph-node-path" /> : <Link className="graph-node-path" draggable={false} href={hrefForPage(node.page.path)} aria-label={`${pageLabel(node.page.path)}, ${node.hop} hop${node.hop === 2 ? 's' : ''}${hasHttpFailure(node.page.statusCode) ? `, HTTP ${node.page.statusCode}` : ''}`}>{pageLabel(node.page.path)}</Link>}
              <span className={`node-direction ${node.incoming && node.outgoing ? 'both' : node.outgoing ? 'outgoing' : 'incoming'}`}>{node.incoming && node.outgoing ? '↔ Both ways' : node.outgoing ? '→ Outgoing' : '← Incoming'}</span>
              <span className="node-hop">{node.hop} {node.hop === 1 ? 'hop' : 'hops'}{hasHttpFailure(node.page.statusCode) ? ` · HTTP ${node.page.statusCode}` : ''}</span>
              {node.page.isExternal && <span className="external-node-label">External · unverified</span>}
              {renderDragHandle(node.page.url, pageLabel(node.page.path))}
            </div>)}
            <div className={`graph-node root ${highlightUrl === focus.url ? 'locate-highlight' : ''} ${hasHttpFailure(focus.statusCode) ? 'broken-node' : ''}`} data-graph-focus-node data-graph-node-id={focus.url} data-moving={draggingNodeId === focus.url} role="group" aria-label={`${pageLabel(focus.path)}, focus page node`} style={{ left: `${sceneSize / 2}px`, top: `${sceneSize / 2}px`, transform: 'translate(-50%,-50%)' }}>{pageLabel(focus.path)}<span className="node-hop">Focus{hasHttpFailure(focus.statusCode) ? ` · HTTP ${focus.statusCode}` : ''}</span>{renderDragHandle(focus.url, `${pageLabel(focus.path)} focus node`)}</div>
          </div>
          </div></div>
          <p id="graph-move-help" className="graph-move-help">Click a captured page name to refocus. External destinations open in a new tab. Drag a Move handle to rearrange a node. Keyboard: focus Move, press Space, use arrow keys, then Space to drop.</p>
          <div className="graph-caption" role="status">{draggingNodeId ? activeDragRef.current?.mode === 'keyboard' ? 'Moving a page node. Use arrow keys to position it; press Space to drop.' : 'Dragging a page node. Release the pointer to place it.' : ''} Displaying {displayedNodesCount} of {network.nodes.length} reachable neighbors ({direct.length}/{allDirect.length} at 1 hop{hops === 2 ? `, ${second.length}/${allSecondCount} at 2 hops` : ''}). Connection details lists all reachable pages and link rows.</div>
        </section>
        <aside className="panel panel-pad connection-panel" aria-label="Connection details" tabIndex={0}>
          <div className="section-title"><h2>Connection details</h2><span className="mono">{network.nodes.length} neighbors</span></div>
          <p className="explorer-note">{focus.title} · {focus.url}</p><p className="explorer-note">{linkRowCount(network.links)} matching link rows · {visibleBroken.length} broken links. Identical link evidence is grouped with its row count.</p>
          <NetworkDetails key={expansionKey} nodes={network.nodes} edges={detailEdges}
            locate={node => {
              const action = () => { updateExpansion(allDirect.length, allSecondCount); setLocateUrl(node.page.url); };
              if (positions.has(node.page.url)) setLocateUrl(node.page.url);
              else confirmExpansion(network.nodes.length, action);
            }}
            heading={node => <div className="connection-node-heading">{node.page.isExternal ? <ExternalDestinationLink url={node.page.url} className="site-link" /> : <Link href={hrefForPage(node.page.path)} className="site-link">{pageLabel(node.page.path)}</Link>}<span className={`hop-badge hop-${node.hop}`}>{node.hop} {node.hop === 1 ? 'hop' : 'hops'}</span>{node.page.isExternal && <span className="external-node-label">External · HTTP unverified</span>}{hasHttpFailure(node.page.statusCode) && <span className="http-error">HTTP {node.page.statusCode}</span>}</div>}
            evidence={edge => <div className={`link-meta ${failures.has(`${edge.fromUrl}|${edge.toUrl}`) ? 'broken-link-meta' : ''}`}>{edge.anchor || 'No anchor text'} · {edge.container}{(edge.count ?? 1) > 1 ? ` · ${edge.count} matching rows` : ''}<br />{renderEvidenceLink(edge.fromUrl)} → {renderEvidenceLink(edge.toUrl, edge.isExternal)}{failures.has(`${edge.fromUrl}|${edge.toUrl}`) && <span className="http-error"> Broken target</span>}</div>}
          />
          {!network.nodes.length && <p className="explorer-note">No {direction === 'all' ? 'direct' : direction} links for this page.</p>}
        </aside>
      </div>
      <BrokenLinks rows={visibleBroken} network hrefForPage={hrefForPage} />
    </> : <div className="panel panel-pad"><h3>No focus page available</h3><p className="explorer-note">Choose a captured page to explore its network.</p></div>}
  </>;
}
