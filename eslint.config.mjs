import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
  ...tseslint.configs.recommendedTypeChecked,
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "obsidianmd/ui/sentence-case": ["warn", {
        mode: "strict",
        brands: [
          "Cloudflare",
          "Obsidian",
          "SecretStorage",
          "Owen",
          "Owen R2 Sync",
          "Worker",
          "Mac",
          "iPhone",
          "Git",
          "owen-brain",
          "owen-mobile",
        ],
        acronyms: ["R2", "URL", "ID", "HTTPS"],
      }],
    },
  },
  { ignores: ["main.js", "*.mjs", "node_modules/**"] }
);
