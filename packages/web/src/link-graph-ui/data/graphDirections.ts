import type { Link } from './sampleData';

export type LinkDirection = 'all' | 'incoming' | 'outgoing';

export function filterLinksByDirection(links: Link[], focusUrl: string, direction: LinkDirection) {
  return links.filter(link =>
    direction === 'all' ||
    (direction === 'incoming' && link.toUrl === focusUrl) ||
    (direction === 'outgoing' && link.fromUrl === focusUrl),
  );
}
