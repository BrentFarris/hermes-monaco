# Hermes Monaco

A Code workspace for Hermes Desktop and its Desktop-derived browser app. The editor follows the **active chat's project**, resolving `host.state.cwd` to every configured project folder on the connected Hermes backend. Ordinary directories and older hosts without the projects RPC retain single-folder behavior. No Hermes core modifications are needed.

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

## Project folders

Every folder configured in the Hermes project appears as a collapsible root. Roots use their Hermes labels or folder names, disambiguate duplicate names with paths, and show the full path on hover. Folder membership is managed in Hermes. Code refreshes it when opened, when Hermes reports a project change, on window focus, and with **Refresh files**. A temporary lookup failure keeps the last known folders and offers **Retry folders**; an unavailable folder has its own retry row.

The project shares one tab strip and one temporary preview tab. Tabs, bookmarks, search, and Open File show folder labels so identical relative paths remain distinct. Text and filename search cover every available root, including unsaved buffers, with at most two outstanding searches and 500 combined results. Ignore rules and include/exclude patterns apply within each root.

New files and folders target the selected tree folder, then the active file's root, then the primary root. Rename, move, and trash operate within the owning root. Root folders cannot be renamed or trashed from Code, and cross-root moves are not supported. Adding or reordering roots preserves existing models and undo history. Removing a root closes its clean tabs and keeps its dirty tabs as detached, recoverable drafts. Re-add that folder in Hermes to save those drafts; their presence also prevents save-before-run from launching incomplete work.

## Editing

- Single-click a file, search result, or bookmark to open an italic **preview tab**. Browsing another file reuses that tab; double-click the file or tab to keep it open. Editing also keeps it open, even after undoing or saving the changes.
- **Middle-click** anywhere on a tab to close it. Unsaved files still offer Save, Discard, or Cancel.
- **Ctrl/Cmd+Shift+P** opens a filename search; **Ctrl/Cmd+Shift+F** searches project text. **Ctrl/Cmd+P** is left to Hermes.
- **Ctrl/Cmd+S** saves the current file; **Ctrl/Cmd+Shift+S** saves all open project files.
- **F5** saves dirty files and runs the selected script when focus is in Code. It also works in the Code side of Split with chat; chat, dialogs, and other views do not launch scripts. The shortcut follows the green Play button's enabled state and does not restart an already running script.
- **Ctrl/Cmd+F** and Monaco's find/replace controls operate on the current file.
- Click the glyph gutter or use **Ctrl/Cmd+F2** to toggle a line bookmark. Name and navigate bookmarks from the left rail.
- Editor settings control indentation, wrapping, font size, and multiple column guides; defaults are **80, 90**.
- Files can be created, renamed, moved, and sent to the backend's OS trash. New nested paths need an existing parent folder. Rename/move saves open files first and updates bookmark references; moving a file resets that editor model's undo history.

Text editing supports UTF-8 files up to **4 MiB**, including UTF-8 BOM and LF/CRLF line endings. Mixed line endings normalize to the file's predominant style when edited in Monaco. Binary, oversized, UTF-16, and invalid UTF-8 files show an unsupported-file message. Symlinks outside the workspace are blocked; linked entries within it can be read, but mutations must target the real entry directly.

Clean open files refresh after external changes. Dirty files retain their content and offer a side-by-side comparison; overwriting requires choosing **Save my version**. Closing a dirty tab offers Save, Discard, or Cancel. File writes require a SHA-256 content revision and publish using a temporary file plus atomic replacement. Revision checks catch changes before and during preparation of a save; filesystem operations cannot provide a transaction with unrelated external writers.

Personal preferences and tab/bookmark metadata use Hermes plugin storage. Dirty buffers use IndexedDB and are separated by backend connection, profile, and canonical folder. Existing folder records are imported into the combined project without deleting legacy records. Combined tab order, active file, collapsed roots, detached roots, and script selection are stored separately per backend/profile/project. State restores when returning to a project or reloading the plugin. Draft persistence is debounced by 150 ms; storage failures are shown explicitly. Browser storage clearing removes that browser's recovery data. Personal state never goes into the repository.

## Markdown documents

Files ending in `.md` or `.markdown` (any capitalization) have **Edit / Split / Preview** controls beside the file path. **Split** is the default: Monaco on the left and a live document on the right. Drag the divider, or focus it and use the arrow keys, to adjust the initial 50/50 split. Home/End set the source share to 20%/80%. Below 720px of editor-area width, source and preview stack vertically and the divider uses Up/Down.

The preview renders the current buffer, including unsaved edits, after a 50ms update delay. Each pane scrolls independently. Edit pauses preview rendering; switching modes keeps Monaco's undo history and cursor. The mode, split ratio, and preview scroll position are stored per open tab in the existing isolated personal metadata and survive reloads, workspace switches, and file moves. Changing mode does not edit the file or keep a temporary tab open. Search and bookmark navigation reveal source by changing Preview to Split.

Markdown supports headings, lists, GFM tables, read-only task checkboxes, fenced code blocks, links, images, and sanitized document HTML such as `<details>`. Relative links resolve from the document's directory; `/` starts at that document's owning root. Additional project roots do not allow links or images to traverse outside the document's root. File links open kept Code tabs, and heading links scroll the document without changing Hermes's route. HTTP(S) links use Hermes's external-link action, with a safe new-tab fallback. Scripts, embedded frames, inline styles, and executable HTML are removed. Mermaid, math rendering, MDX execution, and editing the rendered document are not supported.

Repository images are read from the connected backend through the same workspace confinement as files. PNG, JPEG, GIF, WebP, and SVG are supported up to **4 MiB per image**. SVG stays inside an image element. Images load as they approach the visible preview, with at most four outstanding backend reads; leaving a document discards stale results and releases its image URLs. External HTTP(S) images load directly in the browser with no referrer. Missing, blocked, invalid, or oversized images show their alt text or an unavailable-image placeholder.

Ctrl/Cmd+S, Ctrl/Cmd+Shift+P, and F5 remain available from the preview. Markdown view settings are separate from the temporary **preview tab** feature.

## Shared scripts

The script selector combines every root's `.hermes/scripts.json`, grouped by folder. Selecting an editor tab keeps the chosen script unchanged. **Edit scripts** adds, edits, removes, and reorders commands. Its folder selector starts at the selected script's root, otherwise the active file's root or primary root. Switching folders retains unsaved dialog edits; **Save scripts** saves each changed configuration using its own revision. **Open configuration** opens the currently selected folder's file with JSON schema diagnostics. `.hermes/scripts.json` is created only after explicitly saving script definitions. Commit it to share launchers:

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

`id`, `name`, and `command` are required. IDs must be unique within their root; different roots can use the same ID. `cwd` is relative to the script's owning root and defaults to `.`. A platform override can replace `command`, `cwd`, or `shell`; its `env` is merged with the base environment map. The process inherits the backend's environment. Keep secrets out of this committed file. The authoritative schema is `schemas/scripts.schema.json`.

`default` selects `pwsh`, or Windows PowerShell when `pwsh` is unavailable, on Windows; it selects `sh` on Linux/macOS. Explicit selections are `pwsh`, `powershell`, `cmd`, `sh`, and `bash`. PowerShell runs without a profile and preserves native application exit codes. No interactive input is connected.

The green **▶** saves dirty files across the open project before starting the selected script in its owning root. A conflict, failed save, invalid selected configuration, further edit during launch preparation, project membership change, or workspace switch cancels launch. An invalid configuration disables that folder's scripts while other folders remain usable. Loading a workspace and editing configuration never run commands automatically.

Different scripts may run concurrently, with one active instance per script per root and eight active runs per backend profile. Run Output labels each run with its folder. Stop and Restart terminate the owned process tree (Windows Job Object or POSIX process group). Runs continue when Code closes or a folder/project changes; reopen Run Output to reconnect. Backend shutdown stops its runs. Commands must remain in the foreground: children left behind when their launcher exits are cleaned up. This is a managed launcher, not an interactive terminal, debugger, SSH/container execution adapter, Git UI, or LSP client.

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

The latest checks passed on Windows: **44 backend tests, 37 frontend unit tests, and 31 real Monaco browser tests**. One POSIX-only named-pipe test is skipped on Windows. Coverage includes multi-root identity and membership changes, legacy drafts, detached recovery, bounded combined search, grouped scripts, path confinement, revisions/conflicts, process cleanup, Markdown rendering, themes, and keyboard behavior. An isolated actual Hermes browser host also passed multi-folder discovery and live project events, independent saves, concurrent scripts, draft recovery, Markdown images, and layout checks under its real loader and security policy. Native Desktop was unavailable locally. See [the validation record](docs/validation.md) for the environment, results, and remaining host checklist.

## API and architecture

React/TypeScript source lives in `src/`; Python/FastAPI source lives in `backend/`. `dashboard/plugin_api.py` exports the router without relying on the import name used by Hermes. A private module loader shares backend state with the agent plugin's unload hook. Services are resolved inside each request's Hermes profile context.

All routes are scoped by Hermes to `/api/plugins/hermes-monaco`:

| Route | Purpose |
| --- | --- |
| `GET /health` | API version and text limit |
| `POST /workspace` | Bind one absolute project folder; obtain an opaque handle |
| `GET/POST/PATCH /entries` | Lazy directory listing, create, rename/move |
| `GET/PUT /file` | Read a snapshot; write with `expectedRevision` (null for create-only) |
| `GET /preview-image?workspaceId=…&path=…` | Read a confined image; return `mimeType`, SHA-256 `revision`, and `dataBase64` (4 MiB maximum) |
| `POST /trash` | Recoverable OS deletion |
| `POST /search` | Filename/text search, filters, and dirty overlays |
| `GET/PUT /scripts` | Read/validate/save shared configuration with a revision |
| `GET/POST /runs` | Reconnect to runs; start a saved script by ID and configuration revision |
| `POST /runs/{id}/stop` | Stop its process tree |
| `GET /runs/{id}/output?cursor=N` | Bounded incremental output |

The frontend uses `host.request('projects.for_cwd', { cwd, profile })` and `ctx.onEvent('projects.changed', …)` to discover and refresh membership. Each folder binds separately through the unchanged backend API. Frontend file references are `{ rootKey, path }`; scripts use `{ rootKey, scriptId }`. Backend paths remain relative to one bound root, and handles cannot be reused across profiles. Domain errors return an HTTP-200 `{ "error": { "code", "message", "status", ... } }` envelope because the native Hermes REST bridge flattens non-2xx bodies. This preserves save-conflict snapshots. Request validation and host authentication still use normal HTTP error statuses. No API accepts arbitrary launch commands: it resolves a script from the saved configuration.

Visible views poll bounded subsets of expanded directories and open files, with an immediate refresh on focus. Async results are checked against the captured connection/profile/folder/activation epoch and project membership. Searches share a two-request queue, including old in-flight bridge calls, and discard stale work. Workers, models, subscriptions, styles, and timers are disposed on reload.

The existing `session.v1:<backend/profile/root>` metadata and IndexedDB draft keys are retained. `project.v1:<backend/profile/project>` adds ordered file references, the active reference, collapsed roots, the selected script reference, and descriptors for known and detached roots. Known roots allow draft recovery even when membership changes while Code is closed. Per-folder metadata optionally includes `markdown[path] = { mode, splitRatio, previewScrollTop }`. Missing or invalid values default to `split`, `0.5`, and `0`; ratios are clamped to `0.2`–`0.8`. Legacy `preview` fields are reconciled to one temporary tab across the project. Image reads use a controller-wide queue, including older in-flight reads while switching documents or workspaces. Image data and object URLs are confined to the currently mounted document preview and are not persisted.

## Attribution

Echo inspired the editor organization, multiple folder roots, temporary tabs, column guides, and Markdown rendering. The adapted code retains Echo's MIT attribution in `THIRD_PARTY_NOTICES.md`. Monaco, Marked, and DOMPurify retain their license notices in the bundle and distribution.
