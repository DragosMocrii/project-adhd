export const CLAUDE_PLUGINS_ARRAY: unknown = {
  plugins: [
    {
      id: "superpowers@claude-plugins-official",
      installPath: "/home/vscode/.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0",
      enabled: true,
    },
    { id: "other@somewhere", installPath: "/tmp/other", enabled: true },
  ],
};

export const CLAUDE_PLUGINS_BARE_MAP: unknown = {
  "superpowers@claude-plugins-official": {
    installPath: "/home/vscode/.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0",
  },
};

export const CLAUDE_PLUGINS_DISABLED: unknown = {
  plugins: [
    {
      id: "superpowers@claude-plugins-official",
      installPath: "/tmp/superpowers",
      enabled: false,
    },
  ],
};

export const CLAUDE_PLUGINS_EMPTY: unknown = { plugins: [] };

export const CLAUDE_MARKETPLACES_PRESENT: unknown = {
  marketplaces: [{ name: "claude-plugins-official", source: "github" }],
};

export const CLAUDE_MARKETPLACES_EMPTY: unknown = { marketplaces: [] };

export const CODEX_PLUGINS_INSTALLED: unknown = {
  installed: [{ name: "superpowers", status: "installed" }],
  available: [],
};

export const CODEX_PLUGINS_EMPTY: unknown = { installed: [], available: [] };

export const CODEX_PLUGINS_INSTALLED_STATUS_AVAILABLE: unknown = {
  installed: [{ name: "superpowers", status: "available" }],
  available: [],
};

export const CODEX_PLUGINS_AVAILABLE_ONLY: unknown = {
  installed: [],
  available: [{ name: "superpowers", status: "available" }],
};

export const CODEX_MARKETPLACES_BOTH: unknown = {
  marketplaces: [{ name: "openai-api-curated" }, { name: "openai-curated" }],
};

export const CODEX_MARKETPLACES_API_ONLY: unknown = {
  marketplaces: [{ name: "openai-api-curated" }],
};

export const CODEX_MARKETPLACES_NONE: unknown = { marketplaces: [] };

export const OMP_PLUGINS_INSTALLED: unknown = {
  plugins: [{ name: "superpowers", path: "/home/vscode/.omp/agent/plugins/superpowers", enabled: true }],
};

export const OMP_PLUGINS_DISABLED: unknown = {
  plugins: [{ name: "superpowers", path: "/tmp/superpowers", enabled: false }],
};

export const OMP_PLUGINS_PATHLESS: unknown = {
  plugins: [{ name: "superpowers", enabled: true }],
};
