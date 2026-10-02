# Islet

GitHub issues and pull requests for the repository you're working in, without leaving VS Code.

Islet adds a GitHub panel to the activity bar. It follows the repository selected in Source Control
and shows its issues and pull requests in a calm, Islands-style UI: soft rounded panels, label pills
and a quiet colour palette that only uses colour where it means something.

![Islet showing the issue list and an issue in an editor tab](docs/screenshot.png)

## Features

- **Follows your repository.** Uses the repository selected in Source Control (or the one your
  active file belongs to) and its GitHub remote. Switch repositories and the list follows.
- **Issues and pull requests list** with counts, search, Open / Closed / All, and filters for
  *Created by me*, *Assigned to me* and *Review requested*. Rows show state, labels, comment count,
  check status, review decision and branches.
- **Detail view in an editor tab.** Description, comments with reactions, reviews and events in one
  timeline, plus assignees, labels, milestone, reviewers, checks and participants.
- **Pull requests:** *Files changed* with per-file stats (click a file to open a side-by-side diff),
  *Checks* with status per run, and **Checkout** to switch to the pull request's branch locally.
- **Comment** on issues and pull requests from the detail view (Ctrl+Enter to send).
- Uses VS Code's built-in GitHub sign-in. Islet never stores a token itself.

## Install

Islet isn't on the Marketplace yet. Build the package and install it:

```bash
git clone https://github.com/ReaperMaga/islet.git
cd islet
npm install
npm run package
code --install-extension islet-0.1.0.vsix
```

Then reload VS Code, click the GitHub icon in the activity bar and sign in when asked.

Requirements: VS Code 1.95 or newer, a repository with a GitHub remote, and Git.

## Commands

| Command | What it does |
| --- | --- |
| `Islet: Refresh` | Reloads the list and any open detail tabs. |
| `Islet: Sign in to GitHub` | Signs in with VS Code's GitHub account. |
| `Islet: Open Issue or Pull Request…` | Opens an item by number. |

## Development

```bash
npm install
npm run build       # bundle extension + webviews into dist/
npm run watch       # rebuild on change
npm run typecheck
```

Press F5 in VS Code with this folder open to start an Extension Development Host.

**Previewing the UI in a browser.** `dev/sidebar.html` and `dev/detail.html` run the webviews
with a fake host and recorded data from `src/webview/mock/fixtures.json`, so the design can be
worked on without VS Code. Open them after `npm run build`; the detail page takes
`?kind=issue|pull&number=N`.

**Recording fresh preview data.** `scripts/dump-fixtures.ts` reads from GitHub with the token of the
GitHub CLI (`gh auth token`). It only reads.

**Testing without signing in.** In an Extension Development Host only, Islet uses the token in
the `ISLET_DEV_TOKEN` environment variable if it is set. Installed builds ignore it.

### Project layout

```
src/extension/   extension host: views, panels, auth, repository detection, checkout, diffs
src/api/         GitHub GraphQL client
src/shared/      types and message protocol shared by every part
src/webview/     sidebar and detail webviews, shared theme and helpers, browser mock host
dev/             browser preview pages
```

See [DESIGN.md](DESIGN.md) for the design rules and architecture notes.

## Known limitations

- Review requests to teams are not shown, only to people.
- Pull requests from forks show the branch without the fork owner.
- Commenting is supported; approving, requesting changes and merging are not yet.

## Credits

The look is inspired by JetBrains' Air and Islands interfaces. Islet is an independent project and
is not affiliated with or endorsed by JetBrains.

## License

[MIT](LICENSE)
