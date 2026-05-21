# DesInspect

> A persistent, Chrome-DevTools-style element inspector for any webpage. Edit CSS or HTML, refresh, log in, navigate — your work survives.

DesInspect is a Chrome extension (Manifest V3) that mirrors the Chrome DevTools Elements panel inside the browser's side panel, then quietly writes every edit to IndexedDB scoped to the page's URL. When you come back — after a refresh, a re-login, or an SPA route change — your tweaks are still there.

## Features

- **DevTools-style sidepanel**: collapsible DOM tree on top, tabbed inspector below (Styles · Computed · Box · HTML · Changes · Snapshots).
- **Styles tab** with matched author rules, inline `element.style`, click-to-edit names/values, checkbox toggle per property, color swatches, and `+ add property` / `+ New rule`.
- **Box-model diagram** showing margin / border / padding / content for the selected element.
- **HTML editor** — edit innerHTML and apply with `Cmd/Ctrl + Enter`.
- **Pick mode** — hover the page to highlight, click to select. ESC exits.
- **Persistent auto-save** — every edit lands in IndexedDB, scoped to `origin + pathname`. Cleared session? Page refresh? Your work is re-applied automatically.
- **SPA-aware** — hooks `pushState` / `replaceState` / `popstate` and `webNavigation` so your edits re-apply after client-side route changes.
- **Snapshots** — named save points of the full changeset, restorable in one click.

## Install (unpacked)

1. Clone this repo.
2. Open `chrome://extensions` (Chrome 116+).
3. Toggle **Developer mode** on.
4. Click **Load unpacked**, select this directory.
5. Pin the toolbar icon.

## Use

1. Open any page.
2. Click the DesInspect toolbar icon — the side panel opens.
3. Hit **Pick** (or just expand the DOM tree) and click an element.
4. Edit styles in the **Styles** tab, edit markup in **HTML**, or check the **Box** model.
5. Refresh — your edits are still there.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Cmd/Ctrl + Enter` | Apply HTML edit |
| `Enter` (in style row) | Commit edit |
| `Tab` (in style name) | Jump to value |
| `Esc` | Cancel inline edit / exit picker |

## Architecture

```
manifest.json                  # MV3
background/service-worker.js   # opens side panel, relays sidepanel↔content
content/
  selector.js                  # CSS/XPath selector generation + resolution
  styles-engine.js             # matched rules, computed snapshot, box model
  overlay.js                   # hover & selected highlight on the page
  persistence.js               # IndexedDB-backed re-apply & debounced save
  inspector.js                 # picker, tree serialization, message router
storage/local-db.js            # IndexedDB wrapper (changes + snapshots)
sidepanel/
  index.html                   # tree + tabs layout
  panel.js                     # UI controller
  panel.css                    # DevTools-themed styling
styles/content.css             # injected, overlay-only
```

## Persistence model

Edits are stored as records keyed by `(urlPattern, selector, property)`. All applied edits live in a single `<style id="desinspect-overrides">` tag injected at the end of `<html>`, so they win specificity battles via `!important`. HTML edits set `innerHTML` directly and store the prior value for revert.

Re-apply triggers:
- Initial content-script load (`document_idle`)
- `pushState` / `replaceState` / `popstate`
- A `MutationObserver` re-applies (silently) ~500ms after DOM churn settles, so SPA re-renders don't lose your edits.

## Permissions

- `activeTab`, `scripting`, `<all_urls>` — inject the inspector everywhere.
- `storage` — preferences.
- `sidePanel` — the editor lives there.
- `webNavigation` — SPA route detection.

No network, no telemetry, no remote backend.

## License

MIT — see [LICENSE](LICENSE).
