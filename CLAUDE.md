# Graffiti — Claude Notes

## spec.md
Keep `spec.md` up to date whenever the project structure, data pipeline, controls, or core features change. It is the primary project overview doc.

## Dev server
Don't spin up throwaway `vite` servers (e.g. for benchmarking) and leave them
running. On Windows they orphan easily — bash `ps`/`pkill` can't see or kill
them, only PowerShell `Get-Process node` / `Stop-Process` can — and each one
keeps watching `public/` and burning CPU + ~800 MB RAM, which silently slows
every other dev server. If you must start one, kill it by PID via PowerShell
before moving on. The user runs `npm run dev` themselves (foreground, Ctrl+C to
stop) — prefer asking them to run/observe over starting your own.

## Data
- Building data lives in `public/tiles/` (per-cell binary tiles + `manifest.json`, not committed). No single-file fallback — if the manifest is missing the app errors out.
- Source GML files are in `data/DA_WISE_GMLs/` — DA12 covers FiDi
- To regenerate: `npm run build-tiles` (all DAs) or `npm run build-tiles -- --manhattan`

## Manifests
Manifests are loaded synchronously at page startup — keep them small. Don't emit a manifest just because other streaming managers have one; if tiles live on a uniform grid with deterministic URLs, derive the URL from the player's grid coord and treat 404 as "no tile here". A good rule: if your manifest crosses ~1 MB, you're probably using it to carry data that should be derived, or you're covering a dense grid that doesn't need an index at all.
