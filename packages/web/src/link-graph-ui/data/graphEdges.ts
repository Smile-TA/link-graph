export interface GraphNodeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Trim a center-to-center edge to the measured rectangles, plus room for its arrow tips. */
export function getGraphEdgeEndpoints(source: GraphNodeBox, target: GraphNodeBox, gap = 14) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.hypot(dx, dy);
  const ux = distance ? dx / distance : 1;
  const uy = distance ? dy / distance : 0;
  const boundaryDistance = (box: GraphNodeBox) => Math.min(
    ux ? box.width / (2 * Math.abs(ux)) : Infinity,
    uy ? box.height / (2 * Math.abs(uy)) : Infinity,
  );
  const start = boundaryDistance(source) + gap;
  const end = boundaryDistance(target) + gap;
  return {
    x1: source.x + ux * start,
    y1: source.y + uy * start,
    x2: target.x - ux * end,
    y2: target.y - uy * end,
  };
}
