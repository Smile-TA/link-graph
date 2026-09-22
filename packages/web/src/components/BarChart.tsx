/**
 * One bar chart over a `Bucket[]` (see `distributions.ts`) — the TanStack Charts slot
 * PRD §9 item 4 names. A React island (`client:load` from the Astro page) rather than
 * server-rendered SVG like the treemap: this is the one view that earns interactivity
 * (hover for the exact count), and TanStack Charts renders through React.
 */
import { barY, defineChart } from "@tanstack/charts";
import { Chart } from "@tanstack/charts/react";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import type { Bucket } from "../distributions.js";

interface Props {
  readonly title: string;
  readonly buckets: readonly Bucket[];
}

export function BarChart({ title, buckets }: Props) {
  const definition = defineChart({
    marks: [barY(buckets, { x: "label", y: "count" })],
    scales: {
      x: { scale: () => scaleBand().padding(0.18) },
      y: { scale: scaleLinear, nice: true },
    },
    tooltip,
  });
  return (
    <figure style={{ margin: 0 }}>
      <figcaption>{title}</figcaption>
      <Chart ariaLabel={title} definition={definition} height={220} />
    </figure>
  );
}
