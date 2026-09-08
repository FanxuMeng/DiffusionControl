import * as THREE from 'three';
import type { Face, SceneObject, Vec3 } from './types';
import { FACE_COLORS, referenceAxesForBox } from './objectAxes';

export { FACE_COLORS } from './objectAxes';
export const BASIS = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
export interface SceneGeometry { meshRoot: THREE.Group; cloudRoot: THREE.Group; meshes: Map<string, THREE.Group>; clouds: Map<string, THREE.Group>; pointCount: number; dispose: () => void }
const palette = { plaster: '#e8e1d4', floor: '#c9b99e', wood: '#b99870', ochre: '#c97b48', textile: '#d69662', leaf: '#738e69', pot: '#bd8163' };
const material = (color: string, roughness = .85) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0, side: THREE.DoubleSide });
function add(parent: THREE.Group, geometry: THREE.BufferGeometry, color: string, position: Vec3, rotation: Vec3 = [0, 0, 0]) {
  const mesh = new THREE.Mesh(geometry, material(color)); mesh.position.fromArray(position); mesh.rotation.set(...rotation); mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
}
function box(parent: THREE.Group, size: Vec3, color: string, position: Vec3, rotation?: Vec3) { return add(parent, new THREE.BoxGeometry(...size), color, position, rotation); }
function cylinder(parent: THREE.Group, r1: number, r2: number, height: number, color: string, position: Vec3) { return add(parent, new THREE.CylinderGeometry(r1, r2, height, 36), color, position); }
function ellipsoid(parent: THREE.Group, radii: Vec3, color: string, position: Vec3, rotation: Vec3 = [0, 0, 0]) { const mesh = add(parent, new THREE.SphereGeometry(1, 16, 12), color, position, rotation); mesh.scale.fromArray(radii); return mesh; }
function segment(parent: THREE.Group, from: Vec3, to: Vec3, radius: number, color: string) {
  const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to); const mesh = cylinder(parent, radius, radius * .8, a.distanceTo(b), color, a.clone().add(b).multiplyScalar(.5).toArray() as Vec3); mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.sub(a).normalize()); return mesh;
}
function chair(group: THREE.Group) {
  box(group, [1.01, .15, .92], palette.wood, [0, .23, -.02]);
  box(group, [.97, .19, .85], palette.textile, [0, .09, -.045]);
  box(group, [1.01, .61, .15], palette.ochre, [0, -.36, .36], [-.13, 0, 0]);
  box(group, [.9, .47, .12], palette.textile, [0, -.37, .255], [-.13, 0, 0]);
  for (const x of [-.46, .46]) {
    box(group, [.095, .09, .86], palette.wood, [x, -.16, -.045]);
    segment(group, [x, .22, -.34], [x, -.14, -.34], .032, palette.wood);
    segment(group, [x * .88, .27, .31], [x * 1.12, .85, .43], .041, palette.wood);
    segment(group, [x * .88, .27, -.31], [x * 1.12, .85, -.43], .041, palette.wood);
  }
  box(group, [.72, .018, .04], '#9f6440', [0, .205, -.48]);
}
function table(group: THREE.Group) {
  cylinder(group, .7, .7, .105, '#d1b48a', [0, -.40, 0]);
  cylinder(group, .67, .67, .018, '#e0c7a4', [0, -.46, 0]);
  for (const angle of [0, 2.094, 4.189]) segment(group, [.41 * Math.cos(angle), -.35, .41 * Math.sin(angle)], [.5 * Math.cos(angle), .49, .5 * Math.sin(angle)], .048, '#a28259');
  // The book and cup are part of this rigid object and move with its point cloud.
  box(group, [.29, .047, .39], '#dad3ba', [-.15, -.49, .13], [0, .17, 0]);
  box(group, [.30, .013, .40], '#839580', [-.15, -.52, .13], [0, .17, 0]);
  cylinder(group, .066, .068, .115, '#eee7d9', [.24, -.505, -.07]);
  cylinder(group, .05, .05, .002, '#746146', [.24, -.565, -.07]);
}
function plant(group: THREE.Group) {
  cylinder(group, .22, .32, .48, palette.pot, [0, .96, 0]);
  cylinder(group, .315, .315, .035, '#cd987b', [0, .715, 0]);
  cylinder(group, .28, .28, .02, '#5d5843', [0, .725, 0]);
  const tips: Vec3[] = [[-.10, -1.14, .05], [.39, -.78, -.02], [-.46, -.56, -.04], [.22, -.36, .31], [-.34, -.2, .23], [.47, .04, .04], [-.11, -.77, -.33], [.23, -.57, -.38], [-.47, .03, -.27], [.04, -.1, -.36]];
  tips.forEach((tip, i) => {
    segment(group, [0, .73, 0], tip, .012, '#748061');
    const angle = i * 2.3;
    ellipsoid(group, [.17, .31, .047], i % 3 === 0 ? '#94a176' : palette.leaf, tip, [.25 * Math.sin(angle), angle, .55 * Math.cos(angle)]);
  });
}
function humanoid(group: THREE.Group, color: string) {
  // Six meshes form one rigid instance: masks, picking, bbox and trajectories
  // use their shared parent object ID; there are no independently animated bones.
  // Bounds are exactly .9 × 2.1 × .54, matching the default bbox so the head
  // remains spherical after the generic geometry fitting below.
  box(group, [.52, .75, .38], color, [0, -.14, 0]);
  for (const side of [-1, 1]) {
    box(group, [.17, .8, .30], '#a0c9cc', [side * .365, -.12, 0]);
    box(group, [.21, .79, .32], '#536d86', [side * .145, .655, 0]);
  }
  ellipsoid(group, [.27, .27, .27], '#e2bc95', [0, -.78, 0]);
}
function studioBackground(group: THREE.Group, gallery: boolean) {
  box(group, [9, .06, 11], palette.floor, [0, 1.535, 4.5]);
  box(group, [9, 4.8, .08], palette.plaster, [0, -.85, 8.2]);
  box(group, [.07, 4.8, 11], '#ded7ca', [-4.45, -.85, 4.5]);
  box(group, [.07, 4.8, 11], '#eee8dd', [4.45, -.85, 4.5]);
  box(group, [8.85, .08, .035], '#bbac94', [0, 1.41, 8.12]);
  // Broad window recess and mullions define the architecture without external textures.
  box(group, [.04, 2.5, 3.9], '#b5c9c1', [-4.40, -.92, 5]);
  box(group, [.075, 2.54, .09], '#f3ecdf', [-4.34, -.92, 5]);
  for (const z of [3.08, 6.92]) box(group, [.09, 2.6, .1], '#f1eadd', [-4.32, -.92, z]);
  for (const y of [-2.19, .34]) box(group, [.12, .1, 3.95], '#f1eadd', [-4.3, y, 5]);
  box(group, [.075, .07, 3.9], '#eee6d7', [-4.30, -.86, 5]);
  // Sunlight patches are sampled together with the room surfaces.
  const light = box(group, [2.7, .003, 2.1], '#e8d8af', [-2.05, 1.499, 5.32], [0, -.32, 0]); light.castShadow = false;
  for (const x of [-2.55, -1.7]) box(group, [.045, .006, 2.18], '#c7b79a', [x, 1.495, 5.32], [0, -.32, 0]);
  // Low console, ceramic vessels and a restrained abstract print.
  box(group, [2.7, .08, .55], palette.wood, [.55, .62, 7.7]);
  for (const x of [-.65, 1.75]) box(group, [.06, .8, .43], '#b6976e', [x, 1.05, 7.7]);
  box(group, [1.35, 1.54, .08], '#997f5d', [.4, -.65, 8.12]);
  box(group, [1.22, 1.4, .025], '#f4e8d6', [.4, -.65, 8.065]);
  ellipsoid(group, [.39, .5, .01], gallery ? '#8c9e91' : '#c39976', [.29, -.76, 8.045]);
  box(group, [.54, .035, .012], '#75826e', [.42, -.24, 8.025]);
  ellipsoid(group, [.15, .24, .14], '#cbb391', [-.47, .35, 7.65]);
  cylinder(group, .074, .085, .12, '#cbb391', [-.47, .12, 7.65]);
  ellipsoid(group, [.10, .16, .1], '#d9d1bf', [1.46, .42, 7.65]);
  box(group, [.41, .03, .26], '#8b927a', [.89, .56, 7.55], [0, -.2, 0]);
  // A woven rug is kept separate from the movable furniture.
  box(group, [3.9, .015, 3.05], '#bcbba8', [-.35, 1.485, 5.1]);
  for (const z of [3.65, 6.54]) box(group, [3.76, .005, .035], '#e1d5b8', [-.35, 1.474, z]);
}
function seeded(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
function sampleGroup(group: THREE.Group, seed: number) {
  const random = seeded(seed), positions: number[] = [], colors: number[] = []; const inverse = new THREE.Matrix4(); group.updateMatrixWorld(true); inverse.copy(group.matrixWorld).invert();
  group.traverse(node => {
    if (!(node instanceof THREE.Mesh)) return;
    const geometry = node.geometry, attr = geometry.getAttribute('position'), idx = geometry.index; if (!attr) return;
    const transform = new THREE.Matrix4().multiplyMatrices(inverse, node.matrixWorld), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3();
    const n = idx ? idx.count : attr.count; const triangles: { a: THREE.Vector3; b: THREE.Vector3; c: THREE.Vector3; area: number; shade: number }[] = []; let total = 0;
    for (let i = 0; i < n; i += 3) {
      a.fromBufferAttribute(attr, idx ? idx.getX(i) : i).applyMatrix4(transform); b.fromBufferAttribute(attr, idx ? idx.getX(i + 1) : i + 1).applyMatrix4(transform); c.fromBufferAttribute(attr, idx ? idx.getX(i + 2) : i + 2).applyMatrix4(transform);
      const normal = ab.copy(b).sub(a).cross(ac.copy(c).sub(a)); const area = normal.length() / 2; if (area < 1e-9) continue; normal.normalize();
      total += area; triangles.push({ a: a.clone(), b: b.clone(), c: c.clone(), area: total, shade: .78 + .22 * Math.abs(normal.dot(new THREE.Vector3(-.45, -.76, -.47).normalize())) });
    }
    if (!total) return;
    const count = Math.max(45, Math.min(26000, Math.round(total * 1150))); const base = (node.material as THREE.MeshStandardMaterial).color;
    for (let i = 0; i < count; i++) {
      const pick = random() * total; let lo = 0, hi = triangles.length - 1; while (lo < hi) { const m = (lo + hi) >>> 1; if (triangles[m].area < pick) lo = m + 1; else hi = m; }
      const t = triangles[lo], u = Math.sqrt(random()), v = random(); a.copy(t.a).multiplyScalar(1 - u).addScaledVector(t.b, u * (1 - v)).addScaledVector(t.c, u * v);
      positions.push(a.x, a.y, a.z); const shade = t.shade * (.9 + .18 * random()); colors.push(Math.min(1, base.r * shade), Math.min(1, base.g * shade), Math.min(1, base.b * shade));
    }
  });
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const points = new THREE.Points(geometry, new THREE.PointsMaterial({ size: .02, vertexColors: true, sizeAttenuation: true })); const cloud = new THREE.Group(); cloud.add(points); cloud.position.copy(group.position); cloud.quaternion.copy(group.quaternion); return { cloud, count: positions.length / 3 };
}
export function createSceneGeometry(objects: SceneObject[], gallery = false): SceneGeometry {
  const meshRoot = new THREE.Group(), cloudRoot = new THREE.Group(); const meshes = new Map<string, THREE.Group>(), clouds = new Map<string, THREE.Group>(); let pointCount = 0;
  const background = new THREE.Group(); studioBackground(background, gallery); meshRoot.add(background);
  const sampled = sampleGroup(background, 93041); cloudRoot.add(sampled.cloud); pointCount += sampled.count;
  objects.forEach((object, i) => {
    const group = new THREE.Group(), content = new THREE.Group(); if (object.shape === 'chair') chair(content); else if (object.shape === 'plant') plant(content); else if (object.shape === 'table') table(content); else if (object.shape === 'humanoid') humanoid(content, object.color); else ellipsoid(content, object.halfExtents, object.color, [0, 0, 0]);
    const bounds = new THREE.Box3().setFromObject(content), size = bounds.getSize(new THREE.Vector3()), midpoint = bounds.getCenter(new THREE.Vector3());
    content.scale.set(object.halfExtents[0] * 2 / size.x, object.halfExtents[1] * 2 / size.y, object.halfExtents[2] * 2 / size.z); content.position.copy(midpoint).multiply(content.scale).negate(); group.add(content);
    group.position.fromArray(object.center); group.userData.objectId = object.id;
    group.traverse(n => { n.userData.objectId = object.id; }); meshRoot.add(group); meshes.set(object.id, group);
    const { cloud, count } = sampleGroup(group, 710 + i); cloud.userData.objectId = object.id; cloudRoot.add(cloud); clouds.set(object.id, cloud); pointCount += count;
  });
  meshRoot.quaternion.copy(BASIS); cloudRoot.quaternion.copy(BASIS);
  return { meshRoot, cloudRoot, meshes, clouds, pointCount, dispose: () => {
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
    for (const root of [meshRoot, cloudRoot]) root.traverse(n => { if (n instanceof THREE.Mesh || n instanceof THREE.Points) { geometries.add(n.geometry); for (const m of Array.isArray(n.material) ? n.material : [n.material]) materials.add(m); } });
    geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose());
  } };
}
export function makeBoundingBox(object: SceneObject) {
  const group = new THREE.Group(); group.userData.objectId = object.id; const [x, y, z] = object.halfExtents;
  const faces: { face: Face; size: [number, number]; pos: Vec3; rot: Vec3 }[] = [
    { face: '+x', size: [z * 2, y * 2], pos: [x, 0, 0], rot: [0, Math.PI / 2, 0] }, { face: '-x', size: [z * 2, y * 2], pos: [-x, 0, 0], rot: [0, -Math.PI / 2, 0] },
    { face: '+y', size: [x * 2, z * 2], pos: [0, y, 0], rot: [-Math.PI / 2, 0, 0] }, { face: '-y', size: [x * 2, z * 2], pos: [0, -y, 0], rot: [Math.PI / 2, 0, 0] },
    { face: '+z', size: [x * 2, y * 2], pos: [0, 0, z], rot: [0, 0, 0] }, { face: '-z', size: [x * 2, y * 2], pos: [0, 0, -z], rot: [0, Math.PI, 0] },
  ];
  faces.forEach(f => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(f.size[0], f.size[1], 12, 12), new THREE.MeshBasicMaterial({ color: FACE_COLORS[f.face], transparent: true, opacity: .085, side: THREE.DoubleSide, depthWrite: false })); m.position.fromArray(f.pos); m.rotation.set(...f.rot); m.userData = { objectId: object.id, face: f.face }; group.add(m);
  });
  const edgePoints: THREE.Vector3[] = [];
  for (const axis of [0, 1, 2]) for (const a of [-1, 1]) for (const b of [-1, 1]) {
    const half = [x, y, z], others = [0, 1, 2].filter(index => index !== axis);
    for (let i = 0; i < 16; i++) { const start = [0, 0, 0], end = [0, 0, 0]; start[axis] = (-1 + i / 8) * half[axis]; end[axis] = (-1 + (i + 1) / 8) * half[axis]; start[others[0]] = end[others[0]] = a * half[others[0]]; start[others[1]] = end[others[1]] = b * half[others[1]]; edgePoints.push(new THREE.Vector3(...start), new THREE.Vector3(...end)); }
  }
  const edges = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(edgePoints), new THREE.LineBasicMaterial({ color: object.color, transparent: true, opacity: .9 })); group.add(edges);
  const center = new THREE.Mesh(new THREE.SphereGeometry(.035, 10, 8), new THREE.MeshBasicMaterial({ color: '#fff7df' })); group.add(center);
  for (const axis of referenceAxesForBox(object.halfExtents)) {
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(...axis.direction), new THREE.Vector3(), axis.length, axis.color, Math.min(.09, axis.length * .2), Math.min(.055, axis.length * .12));
    arrow.userData.referenceAxis = axis.face;
    // These are visual guides, never additional pickable bbox faces. Keep them
    // legible through the point cloud and unaffected by lighting or tone mapping.
    for (const part of [arrow.line, arrow.cone]) {
      part.renderOrder = 8;
      const material = part.material as THREE.LineBasicMaterial | THREE.MeshBasicMaterial;
      material.depthTest = false; material.depthWrite = false; material.toneMapped = false; material.fog = false;
    }
    group.add(arrow);
  }
  const frontArrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), Math.max(x, y, z) + .28, '#ed9b62', .14, .09); frontArrow.userData.frontArrow = true; frontArrow.visible = false; group.add(frontArrow);
  group.position.fromArray(object.center); return group;
}
