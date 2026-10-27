export function getGraphLayout(directCount: number, secondCount: number, hops: 1 | 2, zoom: number) {
  const zoomSpread = Math.max(1, 1 + (zoom - 1) * 2);
  const radiusFor = (count: number) => Math.max(150, count * 100 / (Math.PI * 2)) * zoomSpread;
  const directRadius = radiusFor(directCount);
  const secondRadius = directRadius + radiusFor(secondCount);
  const graphRadius = hops === 1 ? directRadius : secondRadius;
  const sceneSize = Math.max(560, Math.ceil((graphRadius + 110 * zoomSpread) * 2));
  return { directRadius, secondRadius, sceneSize, zoomSpread };
}
