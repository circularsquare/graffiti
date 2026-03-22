import * as THREE from 'three';
import { lngLatToLocal } from './geo.js';

// Subtle concrete palette
const WALL_COLORS = [0xd6d4c8, 0xcfcdc1, 0xc8c5b8, 0xdddbd0];

export function buildingToMesh(building) {
  const { coords, height } = building;

  // Drop the closing duplicate vertex OSM adds (first === last)
  const ring = (
    coords[0][0] === coords.at(-1)[0] && coords[0][1] === coords.at(-1)[1]
      ? coords.slice(0, -1)
      : coords
  ).map(([lng, lat]) => lngLatToLocal(lng, lat));

  if (ring.length < 3) return null;

  // Build a THREE.Shape in the XY plane.
  // We use (x, -z) so that after rotateX(-π/2) the building stands up with
  // north pointing toward -Z (Three.js default forward direction).
  const shape = new THREE.Shape();
  ring.forEach(([x, z], i) => {
    if (i === 0) shape.moveTo(x, -z);
    else shape.lineTo(x, -z);
  });

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: false,
  });

  // Rotate so extrusion axis (local +Z) becomes world +Y (up)
  geo.rotateX(-Math.PI / 2);

  const color = WALL_COLORS[building.id % WALL_COLORS.length];
  const mat = new THREE.MeshLambertMaterial({ color });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  mesh.userData.building = { id: building.id, name: building.name, height };

  return mesh;
}
