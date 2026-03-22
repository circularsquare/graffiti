const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// Financial District: roughly Fulton St → Battery Park, Broadway → Water St
const BBOX = '40.7020,-74.0155,40.7075,-74.0080'; // south,west,north,east

export async function fetchBuildings() {
  const query = `[out:json][timeout:30];(way["building"](${BBOX}););(._;>;);out body;`;

  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`,
  });

  if (!res.ok) throw new Error(`Overpass error ${res.status}`);
  const data = await res.json();
  return parseOverpass(data);
}

function parseHeight(tags) {
  if (tags.height) {
    const h = parseFloat(tags.height);
    if (!isNaN(h)) return h;
  }
  if (tags['building:levels']) {
    const levels = parseInt(tags['building:levels'], 10);
    if (!isNaN(levels)) return Math.max(levels * 3.5, 5);
  }
  return 15; // default ~4 floors
}

function parseOverpass(data) {
  // Index all nodes by id
  const nodes = {};
  for (const el of data.elements) {
    if (el.type === 'node') nodes[el.id] = [el.lon, el.lat];
  }

  const buildings = [];
  for (const el of data.elements) {
    if (el.type !== 'way' || !el.tags?.building) continue;

    const coords = el.nodes.map(id => nodes[id]).filter(Boolean);
    if (coords.length < 4) continue; // need at least a triangle + closing node

    buildings.push({
      id: el.id,
      coords,
      height: parseHeight(el.tags),
      name: el.tags.name ?? null,
    });
  }

  return buildings;
}
