# Air GitHub — design and build brief

A VS Code extension that shows the GitHub issues and pull requests of the repository currently
selected in VS Code's Source Control, styled like JetBrains Air / the Islands UI.

## Look and feel (Air / Islands)

The user's VS Code already runs Air dark + Islands panels + Rider syntax colours. The webviews must
feel like part of that, not like a website.

- **Islands.** Content sits in soft rounded panels (`--panel` on `--bg`, 1px `--line` border,
  `--r-lg` 12px radius). Cards inside use `--r` 8px. No hard full-width dividers between sections:
  use space and panels instead.
- **Calm.** Mostly greys. Colour only carries meaning: state (open/closed/merged/draft), checks,
  review status, label colours, links. Accent is Rider blue (`--accent`).
- **Pills.** Labels, state, filters and counts are pills (`--r-pill`). Filters are a segmented pill
  group on `--chip`, active segment `--chip-hover` + `--fg`.
- **Type.** Inter for UI, JetBrains Mono for numbers (`#123`), branch names, counts, file paths.
  Base 13px; titles 14px/600 in lists, 22px/600 in the detail header. Secondary text `--fg2`,
  meta `--fg3`.
- **Density.** 4px grid. List rows ~56–64px tall with 12px horizontal padding, 8px gap between
  rows' content. Hover row = `--chip` fill with `--r` radius (rows are inset 6–8px from the edges,
  like Islands list rows), selected/active = `--chip-hover`.
- **Icons.** Use `icons` / `stateIcon()` from `src/webview/shared/ui.ts` (16px line icons).
- **Motion.** Subtle: 120ms background transitions; skeleton shimmer while loading. Respect
  `prefers-reduced-motion` (theme.css already does).
- **Every colour from a token** in `src/webview/shared/theme.css`. Do not hard-code hex values in
  component CSS. Label colours come from GitHub and go through `labelPill()`.
- States to design for: loading (skeletons), empty (friendly line + action), error (inline banner
  with Retry), signed out (Sign in button), no GitHub repo (explain why).

## Architecture

```
src/shared/types.ts      data model (contract)            [lead]
src/shared/protocol.ts   webview <-> extension messages   [lead]
src/shared/api.ts        GitHubApi interface               [lead]
src/extension/*          extension host                    [agent A]
src/api/*                GitHub GraphQL client             [agent B]
scripts/dump-fixtures.ts real data -> mock fixtures        [agent B]
src/webview/sidebar/*    sidebar list webview              [agent C]
src/webview/detail/*     detail editor-tab webview         [agent D]
src/webview/shared/*     theme tokens, ui helpers, bridge  [lead]
src/webview/mock/*       browser fake host                 [lead; fixtures.json by agent B]
dev/sidebar.html, dev/detail.html  browser preview pages   [lead]
```

- Build: `npm run build` (esbuild, see build.mjs) -> `dist/extension.js`, `dist/sidebar.{js,css}`,
  `dist/detail.{js,css}`, `dist/mock.js`. Type check: `npm run typecheck`.
- A webview entry imports its CSS (`import './sidebar.css'`) and `../shared/theme.css`; esbuild
  emits it as `dist/<name>.css`. The extension's HTML links that CSS and the JS with a CSP nonce.
- Webviews talk to the host only through `src/webview/shared/bridge.ts` (`post`, `request`,
  `onMessage`). In a plain browser the bridge uses `dist/mock.js`, so `dev/*.html` can be opened
  directly (file:// or a static server) to preview with fixture data.
- The detail page in a browser reads `?kind=issue|pull&number=N` from its URL instead of waiting
  for a `showItem` message.
- Auth: `vscode.authentication.getSession('github', ['repo'], …)`. No tokens stored by us.
- Repo: the `vscode.git` extension API; use the repository selected in Source Control
  (`repo.ui.selected`), else the one containing the active editor, else the first. Parse the
  `origin` remote (fallback: first GitHub remote) for owner/name. Follow switches live.
- Data: GitHub GraphQL v4 via `fetch` (Node 20+ in the extension host). `bodyHTML` gives rendered,
  sanitised markdown, so no markdown library is needed.

## Ownership rules for agents

- Only create/edit files in your own area. Do not edit `src/shared/*`, `package.json`,
  `build.mjs`, `tsconfig.json` or another agent's files. If you need a contract change or a new
  dependency, stop and report it instead of working around it.
- Do not run `npm install` for new packages. Already installed: typescript, esbuild,
  @types/vscode, @types/node.
- Keep code plain TypeScript, no UI framework. Match the style of `src/webview/shared/ui.ts`.
- Before finishing: `npm run typecheck` and `npm run build` must pass for your files.
