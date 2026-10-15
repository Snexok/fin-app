import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

// @next/eslint-plugin-next не подключён: он тянет fast-glob -> braces с открытой high-уязвимостью (dev-only), npm audit должен быть чистым.

export default tseslint.config(
  { ignores: ["node_modules/**", ".next/**", ".next-*/**", ".data/**", "next-env.d.ts", "*.tsbuildinfo"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mjs}"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  // UI-код Mini App работает с нетипизированным window.Telegram и событиями Web Speech API.
  { files: ["app/page.tsx"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
  { files: ["tests/**"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
);
