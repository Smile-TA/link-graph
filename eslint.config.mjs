// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // scratch/ is the gitignored throwaway-script location (see .gitignore).
  {
    ignores: [
      "**/dist/",
      "**/coverage/",
      "**/node_modules/",
      "**/.astro/",
      "scratch/",
      // The Link Graph PR pack's UI, vendored as the pack wrote it (default exports, DOM
      // globals, its own conventions). It is type-checked by `astro check`, not linted
      // against this repo's rules — see docs/04-operations.md §8.
      "packages/web/src/link-graph-ui/",
      "packages/web/src/api-client/",
      "packages/web/src/components/",
      "packages/web/src/layouts/",
      "packages/web/tests/",
      "packages/web/*.config.*",
      "packages/web/aliases.mjs",
      "packages/web/src/lib/",
      "packages/web/src/pages/**/*.astro",
      "packages/web/src/pages/data/",
      // Not part of the pack, but not repo-convention either: Tailwind/Astro config.
      "link-graph-pr-pack/",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // §1 of the engineering guide: a dropped promise is a silently dropped page.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/require-await": "error",

      // §6: no `any`, explicit type imports, named exports only.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "ExportDefaultDeclaration",
          message:
            "Named exports only — default exports make renames invisible in review.",
        },
      ],
    },
  },
  {
    // Config files are not part of the TS program.
    files: ["**/*.mjs", "**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Tooling reads these by default export; the convention cannot apply here.
    files: ["*.config.{ts,mjs,js}", "**/*.config.{ts,mjs,js}", "eslint.config.mjs"],
    rules: { "no-restricted-syntax": "off" },
  },
);
