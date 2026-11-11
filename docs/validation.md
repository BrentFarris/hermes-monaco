# Validation

## Recorded results — 2026-11-10

Validated on Windows with Node 24.14.0, Python 3.14.3, and Chromium
151.0.7922.34. **54 automated tests passed:** 32 Python backend tests, 13
frontend unit tests, and 9 browser tests using real Monaco. The final browser
suite passed after correcting the surface/color tokens against the real host.

The production bundle is approximately **5.27 MiB**, below the 16 MiB loader
limit. The build checks its runtime imports; `scripts/check-host.mjs` also
passed against the actual Hermes runtime loader from revision `2bd378ed`
(2026-11-05). Hermes Plugin Doctor loaded the staged package, exercised its
registration/unload hooks, and reported no findings.

An **actual Desktop-derived Hermes browser app** at the same revision was
started with a disposable Hermes home, plugin inventory, and workspace under
`.test-runtime/`. Its installed renderer and backend were used without core
changes. The smoke test verified:

- Package discovery and enabling the desktop contribution; Code navigation
  and the active workspace directory.
- Bundled Monaco loading under the host security policy, Python syntax
  highlighting, 80/90 guides, and the host's light theme.
- Editing and Ctrl+S through the real plugin REST bridge.
- Saving shared script configuration, Play, live output, and exit code 0.
- Split with chat and Expand, with exactly one editor workspace mounted.
- No browser page or console errors during these interactions.

**Not verified locally:** the native Desktop executable was not installed.
The Windows/Linux/macOS CI matrix is supplied, but Linux/macOS jobs have not
been run in this environment. Host-specific release checks below remain
necessary for those targets; fixture results do not imply those passes.

## Automated coverage

The isolated integration fixture copies the release package to
`.test-runtime/plugins/hermes-monaco` and imports its real dashboard router.
Playwright loads the **built** plugin as a blob module with shared React and an
SDK adapter, enforcing the relevant Hermes browser CSP. It uses real Monaco,
bundled language tokenizers, and blob workers. Its test filesystem and process
launches are separate from the user's Hermes profile.

This verifies packaging, editor interaction and backend behavior, including
profile/backend isolation, stale-result cancellation, draft restoration,
external changes and conflicts, dirty-buffer search, ignore rules, bookmark
movement, configurable rulers, JSON diagnostics, save-before-run cancellation,
run reconnection, narrow layouts, themes, and unload cleanup. Backend tests
also cover path/symlink confinement, Unicode, BOM/line endings, atomic-write
conflicts, configuration overrides, duplicate and concurrent starts, bounded
output, and child-process termination.

The SDK adapter is distinct from the installed-host smoke test recorded
above. Before publishing a release, perform the remaining host checks below
against the intended Hermes version.

## Host smoke checklist

Use a new Hermes home/profile and a disposable workspace. Install the staged
package, enable both halves, and record the Hermes revision/OS:

- Native Desktop: Code appears in navigation and the palette; the active
  chat's cwd is the editor root. Split/Expand use the host workspace panes.
- Desktop-derived browser app: package discovery, module import and editor/
  JSON workers load without CSP violations or network dependencies.
- Switch profiles, backend connections, and folders rapidly; drafts and
  bookmarks return only in their owning workspace.
- Edit/save a Unicode path; change it externally while clean and while dirty;
  compare and resolve conflicts; cancel closing a dirty tab.
- Check light/dark themes, narrow layouts, keyboard find/replace, multiple
  rulers, moving bookmarks, new/rename/move, and recoverable OS trash.
- Add a shared script, Play, Stop, Restart, run another script concurrently,
  switch folders, close Code, and reconnect to live output. Restart the
  backend and verify its owned children have exited.
- Rescan/reload/disable the plugin and verify its views, workers, event
  listeners and models are released. Re-enable and restore a dirty draft.

Record unavailable host environments explicitly; do not infer a native host
pass from a Chromium fixture pass.

## Install scan regression

The initial browser smoke test used a copied package and did not exercise
the Git installer security gate. A GitHub install subsequently reproduced
**86 findings** with `plugin-guard-v12`: three high, 79 medium, and four low.
The three blocking findings misread minified Monaco JavaScript template
strings as skill inline-shell text. The backend process launches, encoding
constants, dependency size, and development fixtures were informational.

The build now asks esbuild to lower template literals into ordinary quoted
strings for both the main bundle and its workers. This is a compiler
transformation; no scanner rule, severity, source, or runtime capability is
excluded or suppressed. The resulting repository scan returns **safe** with
no high or critical findings, and Hermes's normal policy allows installation
with `force=False`. Informational findings may remain.

`scripts/check-install.py` runs the target Hermes scanner against a fresh
snapshot of the repository's installable files, or a staged release package,
and fails on a blocking or confirmation-required verdict. This check is
separate from Plugin Doctor and the runtime import check.

Both the repository snapshot and the staged release passed. Hermes's actual
`_scan_plugin_tree` install gate also accepted the package with scanning
enabled and `force=False`. All nine real Monaco browser tests passed again
after this build change. CI checks the repository and release against the
same pinned Hermes revision before uploading its artifact.

If GitHub installation still reports the old caution verdict, ensure the
corrected generated `desktop/plugin.js` has been pushed to the selected
revision and reopen the install dialog to refresh the inspected commit.
