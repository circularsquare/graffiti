# Graffiti — Claude Notes

## spec.md
Keep `spec.md` up to date whenever the project structure, data pipeline, controls, or core features change. It is the primary project overview doc.

## Data
- Building data lives in `public/buildings.json` (pre-converted from CityGML, not committed)
- Source GML files are in `data/DA_WISE_GMLs/` — DA12 covers FiDi
- No OSM fallback — if `buildings.json` is missing, the app shows an error
- To regenerate: `python scripts/convert_citygml.py data/DA_WISE_GMLs/DA12_3D_Buildings_Merged.gml --out public/buildings.json`
