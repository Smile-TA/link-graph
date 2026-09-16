/**
 * "Site shape at a glance" (PRD §9 item 2): an icicle diagram of the URL hierarchy,
 * one horizontal band per path depth, each band split proportionally to how many
 * pages live under it. Icicle rather than a squarified treemap — PRD §9 names both,
 * and slice-by-depth is the simpler layout that still reads as "shape of the site".
 *
 * Coloured by page class (orphan/linked/excluded/…), which every page already carries
 * (`pages.class`) — no per-page inbound-count query is needed for this first slice.
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
  /** Only set on a leaf, i.e. an actual page rather than a path segment. */
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
    return { name, value, leafClass: node.leafClass, children };
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
 */
export function layoutIcicle(root: TreeNode, rootWidth: number): IcicleRect[] {
  const rects: IcicleRect[] = [];
  function place(node: TreeNode, depth: number, x: number, width: number): void {
    if (node.value === 0) return;
    rects.push({ node, depth, x, width });
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
