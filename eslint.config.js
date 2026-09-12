// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", ".data/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // The codebase leans on `unknown` + zod for anything crossing a JSON
      // boundary (scraped payloads, model replies, HTTP bodies) rather than
      // `any` — but a few narrow spots (event parsing, JSON.parse results)
      // are still genuinely dynamic. Warn, don't block.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Deliberate: several modules build up strings/promises conditionally
      // in ways that read fine but aren't literally "no unused expression".
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },
);
