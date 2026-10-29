export function getGraphLayout(directCount: number, secondCount: number, hops: 1 | 2, zoom: number) {
  const zoomSpread = Math.max(1, 1 + (zoom - 1) * 2);
  const radiusFor = (count: number) => Math.max(150, count * 100 / (Math.PI * 2)) * zoomSpread;
  const directRadius = radiusFor(directCount);
  const secondRadius = directRadius + radiusFor(secondCount);
  const graphRadius = hops === 1 ? directRadius : secondRadius;
  // Pad by one node half-width, not by the zoom spread: the ring already grows with zoom,
  // and extra padding is blank scroll area no node can reach.
  const sceneSize = Math.max(420, Math.ceil((graphRadius + 90) * 2));
  return { directRadius, secondRadius, sceneSize, zoomSpread };
}
