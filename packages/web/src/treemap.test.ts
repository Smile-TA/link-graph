import { describe, expect, it } from "vitest";
import { buildTree, layoutIcicle, type TreeLeaf } from "./treemap.js";

const PAGES: TreeLeaf[] = [
  { path: "/", class: "linked" },
  { path: "/blog/", class: "linked" },
  { path: "/blog/post-1/", class: "linked" },
  { path: "/blog/post-2/", class: "orphan" },
  { path: "/about/", class: "orphan" },
];

describe("buildTree", () => {
  it("groups pages by path segment and counts leaves under each node", () => {
    const root = buildTree(PAGES);
    expect(root.value).toBe(5);
    expect(root.leafClass).toBe("linked");
    const blog = root.children.find((child) => child.name === "blog");
    expect(blog?.value).toBe(3);
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
  });
});

describe("layoutIcicle", () => {
  it("splits width proportionally to each child's leaf count", () => {
    const root = buildTree(PAGES);
    const rects = layoutIcicle(root, 100);
    const blogRect = rects.find((rect) => rect.node.name === "blog");
    const aboutRect = rects.find((rect) => rect.node.name === "about");
    // root has 5 leaves; blog carries 3, about carries 1 (the fifth is root's own page).
    expect(blogRect?.width).toBeCloseTo(60);
    expect(aboutRect?.width).toBeCloseTo(20);
  });

  it("never emits a rect for a node with no pages under it", () => {
    const root = buildTree(PAGES);
    const rects = layoutIcicle(root, 100);
    expect(rects.every((rect) => rect.node.value > 0)).toBe(true);
  });
});
