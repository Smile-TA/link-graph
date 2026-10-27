import { fileURLToPath } from "node:url";

const src = (path) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

/**
 * The Link Graph PR pack's UI is written against two workspace package names,
 * `@workspace/link-graph-ui` and `@workspace/api-client-react`, and `@/` for its own
 * `src`. Aliasing them to the vendored folders keeps its imports exactly as the pack wrote
 * them, so a newer pack drops in without editing every file. Shared by the Astro build and
 * the UI tests so both resolve the same files.
 */
export const aliases = [
  { find: "@workspace/link-graph-ui/components", replacement: src("link-graph-ui/components") },
  { find: "@workspace/link-graph-ui/data", replacement: src("link-graph-ui/data") },
  { find: "@workspace/link-graph-ui/hooks", replacement: src("link-graph-ui/hooks") },
  { find: "@workspace/link-graph-ui/views", replacement: src("link-graph-ui/views.tsx") },
  { find: "@workspace/link-graph-ui/styles.css", replacement: src("link-graph-ui/index.css") },
  { find: "@workspace/api-client-react", replacement: src("api-client/index.ts") },
  { find: /^@\/(.*)$/, replacement: src("$1") },
];
