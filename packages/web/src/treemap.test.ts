import { describe, expect, it } from "vitest";
import { buildTree, layoutIcicle, orphanColor, type TreeLeaf, type TreeNode } from "./treemap.js";

function node(value: number, orphanCount: number): TreeNode {
  return { name: "x", value, orphanCount, leafClass: null, children: [] };
}

const PAGES: TreeLeaf[] = [
  { path: "/", class: "linked" },
  { path: "/blog/", class: "linked" },
  { path: "/blog/post-1/", class: "linked" },
  { path: "/blog/post-2/", class: "orphan" },
  { path: "/about/", class: "orphan" },
];

describe("buildTree", () => {
  it("groups pages by path segment and counts leaves and orphans under each node", () => {
    const root = buildTree(PAGES);
    expect(root.value).toBe(5);
    expect(root.orphanCount).toBe(2);
    const blog = root.children.find((child) => child.name === "blog");
    expect(blog?.value).toBe(3);
    expect(blog?.orphanCount).toBe(1);
    expect(blog?.children.map((child) => child.name).sort()).toEqual([
      "post-1",
      "post-2",
    ]);
  });

  it("gives an intermediate directory with no page of its own a null class", () => {
    const root = buildTree([{ path: "/docs/guide/", class: "linked" }]);
    const docs = root.children.find((child) => child.name === "docs");
    expect(docs?.leafClass).toBeNull();
    expect(docs?.value).toBe(1);
    expect(docs?.orphanCount).toBe(0);
  });
});

describe("layoutIcicle", () => {
  it("splits width proportionally to each child's leaf count", () => {
    const root = buildTree(PAGES);
    const rects = layoutIcicle(root, 100, 10);
    const blogRect = rects.find((rect) => rect.node.name === "blog");
    const aboutRect = rects.find((rect) => rect.node.name === "about");
    // root has 5 leaves; blog carries 3, about carries 1 (the fifth is root's own page).
    expect(blogRect?.width).toBeCloseTo(60);
    expect(aboutRect?.width).toBeCloseTo(20);
  });

  it("never emits a rect for a node with no pages under it", () => {
    const root = buildTree(PAGES);
    const rects = layoutIcicle(root, 100, 10);
    expect(rects.every((rect) => rect.node.value > 0)).toBe(true);
  });

  it("stops descending past maxDepth but keeps the cut-off node's full counts", () => {
    const root = buildTree(PAGES);
    const rects = layoutIcicle(root, 100, 1);
    expect(rects.map((rect) => rect.node.name).sort()).toEqual(["/", "about", "blog"]);
    const blogRect = rects.find((rect) => rect.node.name === "blog");
    expect(blogRect?.node.value).toBe(3);
    expect(blogRect?.node.orphanCount).toBe(1);
  });
});

describe("orphanColor", () => {
  it("is pure green at 0% orphan and pure red at 100%", () => {
    expect(orphanColor(node(4, 0))).toBe("#3b7a57");
    expect(orphanColor(node(4, 4))).toBe("#c0392b");
  });

  it("is a blend in between", () => {
    const color = orphanColor(node(2, 1));
    expect(color).not.toBe("#3b7a57");
    expect(color).not.toBe("#c0392b");
  });
});
