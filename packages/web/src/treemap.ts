/**
 * "Site shape at a glance" (PRD §9 item 2): an icicle diagram of the URL hierarchy,
 * one horizontal band per path depth, each band split proportionally to how many
 * pages live under it. Icicle rather than a squarified treemap — PRD §9 names both,
 * and slice-by-depth is the simpler layout that still reads as "shape of the site".
 *
 * **Coloured by orphan ratio, not by one leaf's class.** The first version coloured
 * each individual page's rect by its own class, which is worthless at real scale: a
 * 2,454-page site has orphans scattered as single narrow leaves several path segments
 * deep, invisible once several hundred siblings share a row's width. Rolling up
 * "what fraction of the pages under this directory are orphans" onto every node —
 * down to a capped depth, never per-leaf — means the shape a reader needs ("the
 * `/inspire/` directory is almost entirely orphaned") survives being drawn small.
 */
import type { PageClass } from "@link-graph/db";

export interface TreeLeaf {
  readonly path: string;
  readonly class: PageClass | null;
}

export interface TreeNode {
  readonly name: string;
  /** How many leaves (pages) live under this node — the layout weight. */
  readonly value: number;
  /** How many of those leaves are orphans — the colour weight. */
  readonly orphanCount: number;
  /** Only set when this node is itself a page, i.e. a leaf rather than a directory. */
  readonly leafClass: PageClass | null;
  readonly children: readonly TreeNode[];
}

/** Groups pages by `/`-separated path segment, root first. */
export function buildTree(pages: readonly TreeLeaf[]): TreeNode {
  interface Building {
    leafClass: PageClass | null;
    children: Map<string, Building>;
  }
  const root: Building = { leafClass: null, children: new Map() };

  for (const page of pages) {
    const segments = page.path.split("/").filter((segment) => segment !== "");
    let node = root;
    for (const segment of segments) {
      let next = node.children.get(segment);
      if (next === undefined) {
        next = { leafClass: null, children: new Map() };
        node.children.set(segment, next);
      }
      node = next;
    }
    // The page at "/" itself has no segments, so its class lands on root.
    node.leafClass = page.class;
  }

  function toTreeNode(name: string, node: Building): TreeNode {
    const children = [...node.children.entries()].map(([childName, child]) =>
      toTreeNode(childName, child),
    );
    // Every segment that terminates some page's path had its class set by the loop
    // above; a segment that is purely an ancestor of deeper pages never does.
    const isPage = node.leafClass !== null;
    const value = children.reduce((sum, child) => sum + child.value, 0) + (isPage ? 1 : 0);
    const orphanCount =
      children.reduce((sum, child) => sum + child.orphanCount, 0) +
      (isPage && node.leafClass === "orphan" ? 1 : 0);
    return { name, value, orphanCount, leafClass: node.leafClass, children };
  }
  return toTreeNode("/", root);
}

export interface IcicleRect {
  readonly node: TreeNode;
  readonly depth: number;
  readonly x: number;
  readonly width: number;
}

/**
 * Every node's horizontal span at its depth, in units of `rootWidth` — the caller
 * multiplies by a pixel width and a fixed row height to draw it. A node with no
 * pages under it (`value === 0`, an empty directory) is skipped rather than drawn as
 * a zero-width rect nothing could click.
 *
 * `maxDepth` stops the recursion, not the counting: a node at the cutoff still carries
 * its full descendant `value`/`orphanCount`, so its colour and its label ("312 pages,
 * 40% orphan") speak for a subtree the layout never draws leaf-by-leaf. Without a
 * cutoff a real site's page count draws thousands of sub-pixel rects nothing can see
 * or click, which is what made the first version worthless.
 */
export function layoutIcicle(root: TreeNode, rootWidth: number, maxDepth: number): IcicleRect[] {
  const rects: IcicleRect[] = [];
  function place(node: TreeNode, depth: number, x: number, width: number): void {
    if (node.value === 0) return;
    rects.push({ node, depth, x, width });
    if (depth >= maxDepth) return;
    let cx = x;
    for (const child of node.children) {
      const childWidth = (width * child.value) / node.value;
      place(child, depth + 1, cx, childWidth);
      cx += childWidth;
    }
  }
  place(root, 0, 0, rootWidth);
  return rects;
}

/** Green at 0% orphan, red at 100%, linear in between — no scale nobody asked for. */
export function orphanColor(node: TreeNode): string {
  const ratio = node.orphanCount / node.value;
  const from = { r: 0x3b, g: 0x7a, b: 0x57 };
  const to = { r: 0xc0, g: 0x39, b: 0x2b };
  const mix = (a: number, b: number) => Math.round(a + (b - a) * ratio);
  const channel = (n: number) => n.toString(16).padStart(2, "0");
  return `#${channel(mix(from.r, to.r))}${channel(mix(from.g, to.g))}${channel(mix(from.b, to.b))}`;
}
