# Hermes Monaco

A Code workspace for Hermes Desktop and its Desktop-derived browser app. The editor follows the **active chat's workspace directory** (`host.state.cwd`) on the connected Hermes backend. No Hermes core modifications are needed.

Files, search, bookmarks, editor tabs, and shared script launchers live in one workspace. Use **Split with chat** to keep the conversation visible, and **Expand** to return to the full editor. At narrow widths the sidebar collapses. Run Output can be resized or hidden while commands continue running.

## Install

Requires a recent Hermes with unified desktop packages, `host.openWorkspace`, plugin REST endpoints, and the **16 MiB** runtime source limit. The SDK surface was checked against Hermes commit `2bd378ed` (2026-11-05); older loaders with a 512 KiB limit cannot load this bundle. See the [official SDK and unified package guide](https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk#one-package-both-sdks).

Build and stage a small distributable directory (Node 22 or newer):

```sh
npm ci
npm run build
npm run package
```

The result is `.build/package/hermes-monaco/`. It contains both plugin halves, their licenses, and the scripts schema. Keep the whole folder together; do not install the checkout with `node_modules` or `.venv`. There are no runtime CDN requests. `desktop/plugin.js` includes Monaco, CSS, its icon font, editor and JSON workers, and syntax tokenizers. Only React and the Hermes SDK remain external.

For a GitHub installation, use `https://github.com/BrentFarris/hermes-monaco` in Hermes's Plugins page. The built bundle must be committed and pushed before Retry can see a local fix. The build emits ordinary quoted JavaScript strings because Hermes's install scanner also recognizes a skill inline-shell syntax that can collide with compact template literals. Scanning remains enabled; no force option is required for the verified build. See [install scan troubleshooting](docs/validation.md#install-scan-regression) if an older commit reports a caution verdict.

**Native Desktop, local backend:** copy the staged `hermes-monaco` folder to `$HERMES_HOME/plugins/hermes-monaco/` (normally `~/.hermes/plugins/hermes-monaco`). If using a release ZIP, extract its `hermes-monaco` folder there. Enable the Python half with `hermes plugins enable hermes-monaco` so Hermes admits the declared Python dependencies. Restart the backend if Hermes selects a new environment. In **Capabilities → Plugins**, choose **Rescan** and enable the Desktop half. Hermes copies `desktop/plugin.js` to its app-level desktop plugin inventory. Both halves are opt-in.

**Desktop-derived browser app:** install and enable the complete package on the machine serving Hermes. Rescan/enable the Desktop half in the browser app's Plugins page, then reload if necessary. The browser host serves the same bundle through its desktop plugin endpoint. This plugin does not target the older `hermes dashboard` frontend.

**Native Desktop with WSL or a remote backend:** the Python half belongs in that backend's active Hermes profile. Install the desktop half on the computer running Desktop as well; its `desktop/plugin.js` can be copied to the local `$HERMES_HOME/desktop-plugins/hermes-monaco/plugin.js`. Enable both halves. Repeat backend installation for each profile that needs it. The root, OS trash, shells, paths, and commands are all on the **connected backend's machine**.

Search uses Hermes-managed ripgrep (`hermes pm install ripgrep`), with `rg` on the backend's PATH as a development fallback. Recoverable deletion requires an available OS trash implementation and the declared Send2Trash dependency; an unavailable trash operation reports an error and leaves the entry in place.

## Editing

- Single-click a file, search result, or bookmark to open an italic **preview tab**. Browsing another file reuses that tab; double-click the file or tab to keep it open. Editing also keeps it open, even after undoing or saving the changes.
- **Middle-click** anywhere on a tab to close it. Unsaved files still offer Save, Discard, or Cancel.
- **Ctrl/Cmd+P** opens a filename search; **Ctrl/Cmd+Shift+F** searches project text.
- **Ctrl/Cmd+S** saves the current file; **Ctrl/Cmd+Shift+S** saves all open workspace files.
- **F5** saves dirty files and runs the selected script when focus is in Code. It also works in the Code side of Split with chat; chat, dialogs, and other views do not launch scripts. The shortcut follows the green Play button's enabled state and does not restart an already running script.
- **Ctrl/Cmd+F** and Monaco's find/replace controls operate on the current file.
- Click the glyph gutter or use **Ctrl/Cmd+F2** to toggle a line bookmark. Name and navigate bookmarks from the left rail.
- Editor settings control indentation, wrapping, font size, and multiple column guides; defaults are **80, 90**.
- Files can be created, renamed, moved, and sent to the backend's OS trash. New nested paths need an existing parent folder. Rename/move saves open files first and updates bookmark references; moving a file resets that editor model's undo history.

Text editing supports UTF-8 files up to **4 MiB**, including UTF-8 BOM and LF/CRLF line endings. Mixed line endings normalize to the file's predominant style when edited in Monaco. Binary, oversized, UTF-16, and invalid UTF-8 files show an unsupported-file message. Symlinks outside the workspace are blocked; linked entries within it can be read, but mutations must target the real entry directly.

Clean open files refresh after external changes. Dirty files retain their content and offer a side-by-side comparison; overwriting requires choosing **Save my version**. Closing a dirty tab offers Save, Discard, or Cancel. File writes require a SHA-256 content revision and publish using a temporary file plus atomic replacement. Revision checks catch changes before and during preparation of a save; filesystem operations cannot provide a transaction with unrelated external writers.

Personal preferences and tab/bookmark metadata use Hermes plugin storage. Dirty buffers use IndexedDB and are separated by backend connection, profile, and canonical workspace folder. They are restored when returning to a workspace or reloading the plugin. Draft persistence is debounced by 150 ms; storage failures are shown explicitly. Browser storage clearing removes that browser's recovery data. Personal state never goes into the repository.

## Shared scripts

**Edit scripts** adds, edits, removes, and reorders commands. **Open configuration** opens the underlying file with JSON schema diagnostics. `.hermes/scripts.json` is created only after explicitly saving script definitions. Commit it to share launchers:

```json
{
  "version": 1,
  "scripts": [
    {
      "id": "dev",
      "name": "Launch application",
      "command": "npm run dev",
      "cwd": ".",
      "shell": "default",
      "env": { "PORT": "3000" },
      "platforms": {
        "windows": { "command": "npm.cmd run dev" },
        "linux": { "shell": "sh" },
        "macos": { "shell": "sh" }
      }
    }
  ]
}
```

`id`, `name`, and `command` are required. IDs must be unique. `cwd` is workspace-relative and defaults to `.`. A platform override can replace `command`, `cwd`, or `shell`; its `env` is merged with the base environment map. The process inherits the backend's environment. Keep secrets out of this committed file. The authoritative schema is `schemas/scripts.schema.json`.

`default` selects `pwsh`, or Windows PowerShell when `pwsh` is unavailable, on Windows; it selects `sh` on Linux/macOS. Explicit selections are `pwsh`, `powershell`, `cmd`, `sh`, and `bash`. PowerShell runs without a profile and preserves native application exit codes. No interactive input is connected.

The green **▶** saves dirty files in the current workspace before starting its saved script definition. A conflict, failed save, invalid configuration, further edit during launch preparation, or workspace switch cancels launch. Loading a workspace and editing configuration never run commands automatically.

Different scripts may run concurrently, with one active instance per script per workspace and eight active runs per backend profile. Stop and Restart terminate the owned process tree (Windows Job Object or POSIX process group). Runs continue when Code closes or the workspace changes; reopen Run Output to reconnect. Backend shutdown stops its runs. Commands must remain in the foreground: children left behind when their launcher exits are cleaned up. This is a managed launcher, not an interactive terminal, debugger, SSH/container execution adapter, Git UI, or LSP client.

Output includes stdout/stderr, status and exit code. Each run retains at most 1 MiB; up to 32 completed runs remain in backend memory. Output cursors detect truncated history. Runs/output are not persisted across backend restarts.

## Development and validation

```sh
python -m venv .venv
# Activate .venv: .venv\Scripts\Activate.ps1 on Windows, or source .venv/bin/activate
python -m pip install -r requirements-dev.lock
npm ci
npm run build
npm test
python -m pytest
npx playwright install chromium
npm run test:e2e
```

`requirements-dev.lock` pins the test environment; `pyproject.toml` declares compatible runtime dependencies for Hermes's shared environment. `package-lock.json` locks JavaScript dependencies. `npm run build` type-checks, bundles, rejects unexpected runtime imports, and enforces the 16 MiB source limit. `npm run package` stages the release folder. `npm run dev` starts a loopback integration fixture at `http://127.0.0.1:4317`, using isolated copies of the packaged backend/UI and workspaces under `.test-runtime/`; it never uses your live Hermes profile. Set `PYTHON` to choose an interpreter and `CHROMIUM_PATH` for an existing Chromium executable.

Before distributing a build, check both Hermes's loader and its separate install-time scanner against the target Hermes source checkout:

```sh
node scripts/check-host.mjs /path/to/hermes-agent
python -B scripts/check-install.py --hermes-source /path/to/hermes-agent --report .build/install-scan.json
python scripts/check-dependencies.py --hermes-source /path/to/hermes-agent
```

The scan command includes Git-tracked and non-ignored new source files, mirroring a fresh repository installation. It exits unsuccessfully if Hermes requires confirmation or blocks installation. Add `--package .build/package/hermes-monaco` to check the release folder as well. It never changes the scanner or grants an override.

The dependency check requires `uv` (CI pins 0.13.5). It resolves this plugin's runtime requirements against Hermes's complete lock in a temporary workspace, preserving every platform branch and installing nothing. `psutil` is a test-only dependency; process management at runtime uses Windows Job Objects or POSIX process groups, leaving Hermes's own `psutil` pins unconstrained.

Backend tests cover path confinement, revisions, BOM/CRLF, ignore rules, dirty search overlays, configuration, concurrent scripts, process tree termination, and output limits. Frontend tests cover routing and settings; Playwright exercises the built bundle and real Monaco under the browser host's relevant CSP restrictions. The latest frontend checks passed on Windows: 13 unit tests and 15 browser tests, including preview tabs, middle-click closing, F5 launch scoping, dialogs under Glass styling, and narrow layouts. An isolated actual Hermes browser host also passed discovery, editing/saving, shared script execution/output, Split/Expand, and dark/glass dialog smoke tests. Native Desktop was unavailable locally. See [the validation record](docs/validation.md) for the environment, results, and remaining host checklist.

## API and architecture

React/TypeScript source lives in `src/`; Python/FastAPI source lives in `backend/`. `dashboard/plugin_api.py` exports the router without relying on the import name used by Hermes. A private module loader shares backend state with the agent plugin's unload hook. Services are resolved inside each request's Hermes profile context.

All routes are scoped by Hermes to `/api/plugins/hermes-monaco`:

| Route | Purpose |
| --- | --- |
| `GET /health` | API version and text limit |
| `POST /workspace` | Bind an absolute active workspace directory; obtain an opaque handle |
| `GET/POST/PATCH /entries` | Lazy directory listing, create, rename/move |
| `GET/PUT /file` | Read a snapshot; write with `expectedRevision` (null for create-only) |
| `POST /trash` | Recoverable OS deletion |
| `POST /search` | Filename/text search, filters, and dirty overlays |
| `GET/PUT /scripts` | Read/validate/save shared configuration with a revision |
| `GET/POST /runs` | Reconnect to runs; start a saved script by ID and configuration revision |
| `POST /runs/{id}/stop` | Stop its process tree |
| `GET /runs/{id}/output?cursor=N` | Bounded incremental output |

File references are relative to a bound workspace; handles cannot be reused across backend profiles. Domain errors return an HTTP-200 `{ "error": { "code", "message", "status", ... } }` envelope because the native Hermes REST bridge flattens non-2xx bodies. This preserves save-conflict snapshots. Request validation and host authentication still use normal HTTP error statuses. No API accepts arbitrary launch commands: it resolves a script from the saved configuration.

Visible views poll bounded subsets of expanded directories and open files, with an immediate refresh on focus. Async results are checked against the captured connection/profile/folder/activation epoch. Workers, models, subscriptions, styles, and timers are disposed on reload.

## Attribution

Echo inspired the editor organization, preview tabs, and column guide helper. The adapted code retains Echo's MIT attribution in `THIRD_PARTY_NOTICES.md`. Monaco and its embedded dependencies retain their license notices in the bundle and distribution.
