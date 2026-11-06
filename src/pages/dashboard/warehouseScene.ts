// Dashboard stage: an open 3D warehouse world built with Three.js, laid out like the site floor plan.
// Two buildings without outer walls, so every area can be seen:
//   left building  - repairs and clinic (sorting, charging, assessment), picking & packing, receiving IN with the laser
//                    station, staff entrance and security, service block, PM & admin offices, binning, pre-production,
//                    production, the quarantine cage and the office column on the west side;
//   right building - receiving IN (returns), green binning, picking & packing (dispatch staging), dispatch OUT and offices;
//   outside        - the road with lorries reversing onto the docks, delivery vans, and the finance / reports offices.
// Every object belongs to an area. Hovering highlights the area, clicking it calls onSelect so the page can open a
// frosted stats card, and the camera flies to it. Drag to orbit, right-drag to pan, Ctrl + scroll to zoom.
// With "reduce motion" switched on, nothing moves on its own. Without WebGL, start() returns null.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const BLUE = '#8ecff5';
const INK = '#1d1d1b';
const SKY = '#d6e4ee';

export type ZoneKey =
  | 'receiving' | 'returns' | 'binning' | 'movements' | 'preproduction' | 'production' | 'picking' | 'dispatch' | 'delivery'
  | 'repairs' | 'assessments' | 'discrepancies' | 'invoicing' | 'reports' | 'users' | 'settings' | 'audit' | 'notifications';
export type AnchorPositions = Partial<Record<ZoneKey, { x: number; y: number; visible: boolean }>>;

type Rect = [x0: number, x1: number, z0: number, z1: number];
interface ZoneDef { rects: { r: Rect; color: string }[]; ground?: boolean }

const FLOOR = 0.25;   // top of the building slabs

// areas, in floor plan order (x runs west to east, z runs north to south; the road is on the north side)
const ZONES: Record<ZoneKey, ZoneDef> = {
  receiving: { rects: [{ r: [-10.8, -6, -15, -8.8], color: '#ffffff' }, { r: [-6, -3.6, -15, -10.6], color: '#ef9a92' }] },
  picking: { rects: [{ r: [-17.4, -10.8, -15, -8.8], color: '#ffffff' }] },
  assessments: { rects: [{ r: [-27.6, -17.6, -15, -7.6], color: '#ffffff' }] },
  repairs: { rects: [{ r: [-33.6, -27.6, -15, -7.6], color: '#f4f6f8' }] },
  audit: { rects: [{ r: [-3.6, 2.4, -15, -10.6], color: '#dfe8ef' }, { r: [-33.6, -28.4, -5.8, -2.6], color: '#dfe8ef' }, { r: [-33.6, -28.4, 11, 14.4], color: '#dfe8ef' }] },
  notifications: { rects: [{ r: [2.4, 10.8, -14.6, -9.8], color: '#e9f3fa' }] },
  users: { rects: [{ r: [-5, 12.6, -8.9, -6.3], color: '#e9f3fa' }] },
  binning: { rects: [{ r: [-15.8, -9.2, -4.2, 11], color: '#c4d2dc' }] },
  preproduction: { rects: [{ r: [-25, -16.8, -2.6, 13.4], color: '#ffffff' }] },
  production: { rects: [{ r: [-7.8, 12.4, -3, 13.4], color: '#f8cdc6' }] },
  discrepancies: { rects: [{ r: [-26.2, -19.6, 13.8, 15.5], color: '#f3d5d2' }] },
  settings: { rects: [{ r: [-33.6, -28.4, 0, 9.6], color: '#e9f3fa' }, { r: [30.8, 34.1, -6, 6], color: '#e9f3fa' }] },
  returns: { rects: [{ r: [15, 21.6, -15, -9.6], color: '#ffffff' }] },
  movements: { rects: [{ r: [13.6, 20.2, -4.2, 11], color: '#cfe9d2' }] },
  dispatch: { rects: [{ r: [22.4, 29.8, -15, -9.6], color: '#ffffff' }, { r: [22, 29.8, -1, 4.6], color: '#ffffff' }] },
  delivery: { rects: [{ r: [29.9, 36.2, -23.6, -16], color: '#8e9ea9' }], ground: true },
  reports: { rects: [{ r: [-46, -36.5, -7.4, -0.8], color: '#ffffff' }], ground: true },
  invoicing: { rects: [{ r: [-46, -36.5, 0.8, 7.4], color: '#ffffff' }], ground: true },
};
export const ZONE_KEYS = Object.keys(ZONES) as ZoneKey[];

// repeatable "random" numbers, so the layout is the same on every visit
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** A timed route: arrive at p by time t (seconds into the cycle). rev = the vehicle reverses along this leg. */
type Waypoint = { p: [number, number]; t: number; rev?: boolean };
function follow(route: Waypoint[], cycle: number, time: number) {
  const u = ((time % cycle) + cycle) % cycle;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1], b = route[i];
    if (u <= b.t) {
      const k = ease((u - a.t) / Math.max(0.0001, b.t - a.t));
      const dx = b.p[0] - a.p[0], dz = b.p[1] - a.p[1];
      const moving = Math.hypot(dx, dz) > 0.01;
      let heading: number | null = null;
      if (moving) heading = Math.atan2(-dz, dx) + (b.rev ? Math.PI : 0);
      return { x: a.p[0] + dx * k, z: a.p[1] + dz * k, heading, moving };
    }
  }
  const l = route[route.length - 1];
  return { x: l.p[0], z: l.p[1], heading: null, moving: false };
}

export interface WarehouseScene {
  stop: () => void;
  /** highlight an area and fly the camera to it (null = back to the overview); does not call onSelect */
  select: (z: ZoneKey | null) => void;
  setAlerts: (z: ZoneKey[]) => void;
  zoom: (factor: number) => void;
}
export interface SceneOptions {
  brand: string;
  enabled: ZoneKey[];
  onAnchors: (a: AnchorPositions) => void;
  onSelect: (z: ZoneKey | null) => void;
  onHover?: (z: ZoneKey | null) => void;
}

export function startWarehouseScene(host: HTMLElement, opts: SceneOptions): WarehouseScene | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch {
    return null;
  }
  const small = Math.min(innerWidth, innerHeight) < 700;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, small ? 1.5 : 1.75));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.touchAction = 'none';
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  const fog = new THREE.Fog(SKY, 90, 190);
  scene.fog = fog;
  const camera = new THREE.PerspectiveCamera(36, 1, 0.3, 420);
  const rnd = seeded(20261106);
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const enabled = new Set(opts.enabled);

  // ---------- helpers ----------
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const std = (color: string, roughness = 0.8, metalness = 0.05, extra: THREE.MeshStandardMaterialParameters = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
  const M = {
    dark: std(INK, 0.55, 0.2),
    steel: std('#3a4652', 0.45, 0.55),
    deck: std('#9aa7b1', 0.6, 0.4),
    blue: std(BLUE, 0.45, 0.1),
    green: std('#5fae74', 0.55, 0.15),
    white: std('#f4f7f9', 0.55),
    wood: std('#b88f5e', 0.9),
    kraft: std('#c9a27a', 0.85),
    rubber: std('#202326', 0.9),
    glass: std('#9fd6f7', 0.12, 0.4, { emissive: '#3c6f8f', emissiveIntensity: 0.25 }),
    pane: std('#bfe4fa', 0.1, 0.2, { transparent: true, opacity: 0.35 }),
    skin: std('#c9a585', 0.8),
    rose: std('#e8857f', 0.6),
    red: new THREE.MeshBasicMaterial({ color: '#ff3b30' }),
    lamp: new THREE.MeshBasicMaterial({ color: '#eaf6ff' }),
    beacon: new THREE.MeshBasicMaterial({ color: BLUE }),
    amber: new THREE.MeshBasicMaterial({ color: '#ffb547' }),
    ledOn: new THREE.MeshBasicMaterial({ color: '#5be37d' }),
    ledOff: new THREE.MeshBasicMaterial({ color: '#2b3a33' }),
  };
  const screens = [0, 1, 2].map((i) => std('#bfe4fa', 0.3, 0, { emissive: ['#7fc6f2', '#a5e3c0', '#ffd59a'][i], emissiveIntensity: 0.6 }));
  function box(w: number, h: number, d: number, mat: THREE.Material | THREE.Material[], x: number, y: number, z: number, parent: THREE.Object3D, shadow = true) {
    const m = new THREE.Mesh(unitBox, mat);
    m.scale.set(w, h, d);
    m.position.set(x, y, z);
    m.castShadow = shadow;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }
  function wheel(r: number, w: number, parent: THREE.Object3D, x: number, y: number, z: number) {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, z);
    const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 18), M.rubber);
    c.rotation.x = Math.PI / 2;
    c.castShadow = true;
    pivot.add(c);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.45, r * 0.45, w + 0.02, 10), M.deck);
    hub.rotation.x = Math.PI / 2;
    pivot.add(hub);
    parent.add(pivot);
    return pivot;
  }
  function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, repeat?: [number, number]) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d')!, w, h);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = maxAniso;
    if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
    return t;
  }
  function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    g.beginPath();
    g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  // dark sign with a light blue bar and white capitals, shrunk to fit
  function sign(text: string, width: number, x: number, y: number, z: number, parent: THREE.Object3D, rotY = 0, accent = BLUE) {
    const px = Math.round(width * 180);
    const tex = canvasTex(px, 160, (g, w, h) => {
      roundRect(g, 0, 0, w, h, 26); g.fillStyle = INK; g.fill();
      g.fillStyle = accent; g.fillRect(36, h - 30, w - 72, 10);
      g.fillStyle = '#fff'; g.font = '600 80px Outfit, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      const tw = g.measureText(text).width;
      if (tw > w - 80) g.font = `600 ${Math.floor(80 * ((w - 80) / tw))}px Outfit, system-ui, sans-serif`;
      g.fillText(text, w / 2, h / 2 - 8);
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(width, width * (160 / px)), new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide }));
    m.position.set(x, y, z);
    m.rotation.y = rotY;
    parent.add(m);
    return m;
  }

  // ---------- areas: one group per area, so a click anywhere on it finds the area ----------
  const G = {} as Record<ZoneKey, THREE.Group>;
  const padMats = {} as Record<ZoneKey, THREE.MeshStandardMaterial[]>;
  const rings = {} as Record<ZoneKey, THREE.Mesh>;
  const centers = {} as Record<ZoneKey, THREE.Vector3>;
  const sizes = {} as Record<ZoneKey, number>;
  const ringGeo = new THREE.RingGeometry(1.15, 1.45, 48);
  for (const key of ZONE_KEYS) {
    const g = new THREE.Group();
    g.userData.zone = key;
    scene.add(g);
    G[key] = g;
    const def = ZONES[key];
    padMats[key] = [];
    def.rects.forEach(({ r: [x0, x1, z0, z1], color }, i) => {
      const mat = std(color, 0.85, 0, { emissive: BLUE, emissiveIntensity: 0 });
      padMats[key].push(mat);
      const y = def.ground ? 0.03 : FLOOR + 0.012 + i * 0.002;
      const pad = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), mat);
      pad.rotation.x = -Math.PI / 2;
      pad.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
      pad.receiveShadow = true;
      g.add(pad);
      // a thin dark edge round the area, like the lines on the plan
      for (const [w, d, x, z] of [[x1 - x0, 0.08, (x0 + x1) / 2, z0], [x1 - x0, 0.08, (x0 + x1) / 2, z1], [0.08, z1 - z0, x0, (z0 + z1) / 2], [0.08, z1 - z0, x1, (z0 + z1) / 2]] as const)
        box(w, 0.04, d, M.steel, x, y + 0.02, z, g, false);
    });
    const [x0, x1, z0, z1] = def.rects[0].r;
    centers[key] = new THREE.Vector3((x0 + x1) / 2, def.ground ? 0 : FLOOR, (z0 + z1) / 2);
    sizes[key] = Math.max(x1 - x0, z1 - z0);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: BLUE, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(centers[key].x, centers[key].y + 0.05, centers[key].z);
    ring.visible = enabled.has(key);
    g.add(ring);
    rings[key] = ring;
  }

  // ---------- light ----------
  scene.add(new THREE.HemisphereLight('#f1f8fd', '#93a8b6', 1.35));
  const sun = new THREE.DirectionalLight('#ffffff', 1.9);
  sun.position.set(30, 48, 26);
  sun.castShadow = true;
  sun.shadow.mapSize.set(small ? 1024 : 2048, small ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -62, right: 62, top: 46, bottom: -46, near: 5, far: 160 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.08;
  scene.add(sun);

  // ---------- ground, road, building slabs (no walls) ----------
  const groundTex = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#e4ebf0'; g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(70,100,120,.08)'; g.lineWidth = 2; g.strokeRect(0, 0, w, h);
  }, [90, 70]);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 300), std('#ffffff', 0.95, 0, { map: groundTex }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(-5, 0, -5);
  ground.receiveShadow = true;
  scene.add(ground);
  const flat = (w: number, d: number, mat: THREE.Material, x: number, z: number, y = 0.01, parent: THREE.Object3D = scene) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
    m.rotation.x = -Math.PI / 2; m.position.set(x, y, z); m.receiveShadow = true; parent.add(m); return m;
  };
  const roadTex = canvasTex(512, 128, (g, w, h) => {
    g.fillStyle = '#9eacb6'; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,.85)'; g.fillRect(0, h / 2 - 3, w * 0.55, 6);
    g.fillStyle = 'rgba(255,255,255,.6)'; g.fillRect(0, 4, w, 3); g.fillRect(0, h - 7, w, 3);
  }, [40, 1]);
  flat(400, 6.4, std('#ffffff', 1, 0, { map: roadTex }), 0, -28.25, 0.015);
  const asphalt = std('#aab7c0', 1, 0);
  flat(50, 9.4, asphalt, 12, -19.9, 0.012);                    // dock apron
  flat(9.4, 7.4, std('#c9d4db', 1, 0), -41.2, 0, 0.012);        // offices forecourt
  // grass verges and a few trees around the site
  const grass = std('#cfe2cf', 1, 0);
  flat(400, 8, grass, 0, -36, 0.008);
  const treeMat = std('#8fc29a', 0.9), trunkMat = std('#8c6f55', 0.9);
  for (let i = 0; i < 26; i++) {
    const x = -70 + i * 5.6 + rnd() * 2, z = -36 + (rnd() - 0.5) * 4;
    const s = 0.8 + rnd() * 0.6;
    box(0.25, 1.4 * s, 0.25, trunkMat, x, 0.7 * s, z, scene);
    const crown = new THREE.Mesh(new THREE.SphereGeometry(1.1 * s, 12, 10), treeMat);
    crown.position.set(x, 1.9 * s, z); crown.castShadow = true; scene.add(crown);
  }

  const slab = (x0: number, x1: number, z0: number, z1: number, color: string) => {
    box(x1 - x0, FLOOR, z1 - z0, std(color, 0.9), (x0 + x1) / 2, FLOOR / 2, (z0 + z1) / 2, scene, false);
    for (const [w, d, x, z] of [[x1 - x0, 0.14, (x0 + x1) / 2, z0], [x1 - x0, 0.14, (x0 + x1) / 2, z1], [0.14, z1 - z0, x0, (z0 + z1) / 2], [0.14, z1 - z0, x1, (z0 + z1) / 2]] as const)
      box(w, 0.1, d, M.dark, x, FLOOR + 0.05, z, scene, false);
  };
  slab(-33.6, 13.2, -15, 15.6, '#cfe3f1');
  slab(13.2, 34.2, -15, 15.6, '#dcedf8');
  // roof columns only: a light steel grid that shows the building outline without walls
  for (const [x0, x1] of [[-33.6, 13.2], [13.2, 34.2]] as const) {
    for (let x = x0; x <= x1 + 0.01; x += (x1 - x0) / Math.round((x1 - x0) / 7)) for (const z of [-15, 15.6]) box(0.22, 7, 0.22, M.steel, x, FLOOR + 3.5, z, scene);
  }

  // ---------- receiving IN (left building) ----------
  function dockGantry(x: number, text: string, parent: THREE.Object3D, accent = BLUE) {
    for (const s of [-1, 1]) box(0.24, 5.4, 0.24, M.dark, x + s * 2.6, FLOOR + 2.7, -15.2, parent);
    box(5.6, 0.3, 0.3, M.dark, x, FLOOR + 5.3, -15.2, parent);
    box(4.4, 0.18, 2.2, M.deck, x, FLOOR - 0.02, -16.1, parent);           // dock leveller
    box(4.6, 0.12, 0.12, M.amber, x, FLOOR + 0.1, -17.2, parent, false);  // bumper
    sign(text, 4.4, x, FLOOR + 6.2, -15.2, parent, 0, accent);
    const lamp = box(0.5, 0.22, 0.22, M.beacon, x + 2.2, FLOOR + 5.05, -15.0, parent, false);
    return lamp;
  }
  const dockLamps: THREE.Mesh[] = [];
  dockLamps.push(dockGantry(-8.4, 'IN · RECEIVING', G.receiving));
  dockLamps.push(dockGantry(18.3, 'IN · RETURNS', G.returns));
  dockLamps.push(dockGantry(26.1, 'OUT · DISPATCH', G.dispatch, '#e8857f'));

  // pallets waiting at receiving, with scanners
  const tint = ['#c9a27a', '#d6b38b', '#b98d63', '#c29a70', '#e9eef2', BLUE];
  function palletStack(parent: THREE.Object3D, x: number, z: number, layers: number, y = FLOOR) {
    box(1.9, 0.14, 2.2, M.wood, x, y + 0.07, z, parent);
    for (let l = 0; l < layers; l++) for (const dx of [-0.46, 0.46]) for (const dz of [-0.53, 0.53])
      box(0.88, 0.62, 1.02, std(tint[Math.floor(rnd() * 4)], 0.85), x + dx, y + 0.14 + 0.31 + l * 0.64, z + dz, parent);
  }
  palletStack(G.receiving, -9.6, -12.2, 2);
  palletStack(G.receiving, -9.6, -9.8, 1);
  palletStack(G.returns, 16.4, -12.6, 1);
  palletStack(G.returns, 20.2, -11.2, 2);
  // laser engraving station on the red pad
  box(1.8, 1.1, 1.3, M.dark, -4.8, FLOOR + 0.55, -13.6, G.receiving);
  box(1.6, 0.06, 1.1, M.pane, -4.8, FLOOR + 1.12, -13.6, G.receiving, false);
  const laser = box(0.04, 0.8, 0.04, M.red, -4.8, FLOOR + 0.75, -13.6, G.receiving, false);
  box(0.9, 0.5, 0.1, M.dark, -4.8, FLOOR + 1.45, -14.2, G.receiving);
  sign('LASER', 1.6, -4.8, FLOOR + 2.2, -13.0, G.receiving, 0, '#e8857f');

  // ---------- people ----------
  const vestMats = [std(BLUE, 0.7), std('#f4f7f9', 0.7), std('#4c5b66', 0.7), std('#ffb547', 0.7)];
  function person(vest: THREE.Material, parent: THREE.Object3D) {
    const g = new THREE.Group();
    const legs: THREE.Group[] = [], arms: THREE.Group[] = [];
    for (const s of [-1, 1]) {
      const hip = new THREE.Group(); hip.position.set(0.12 * s, 0.86, 0); g.add(hip);
      box(0.17, 0.84, 0.2, M.dark, 0, -0.42, 0, hip); legs.push(hip);
      const sh = new THREE.Group(); sh.position.set(0.33 * s, 1.52, 0); g.add(sh);
      box(0.12, 0.62, 0.14, vest, 0, -0.3, 0, sh); arms.push(sh);
    }
    box(0.52, 0.72, 0.3, vest, 0, 1.24, 0, g);
    box(0.53, 0.07, 0.31, M.white, 0, 1.12, 0, g, false);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 12), M.skin);
    head.position.y = 1.8; head.castShadow = true; g.add(head);
    const hat = new THREE.Mesh(new THREE.SphereGeometry(0.185, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), M.white);
    hat.position.y = 1.85; hat.castShadow = true; g.add(hat);
    parent.add(g);
    return { g, legs, arms };
  }
  type Person = ReturnType<typeof person>;
  const workers: Person[] = [];          // stand or sit and work with their hands
  const seated: Person[] = [];
  function worker(parent: THREE.Object3D, x: number, z: number, rotY: number, vest = vestMats[Math.floor(rnd() * 4)]) {
    const p = person(vest, parent);
    p.g.position.set(x, FLOOR, z);
    p.g.rotation.y = rotY;
    workers.push(p);
    return p;
  }
  // a desk with a screen and a seated person; rotY turns the whole workstation
  function workstation(parent: THREE.Object3D, x: number, z: number, rotY = 0, y = FLOOR) {
    const g = new THREE.Group();
    g.position.set(x, y, z); g.rotation.y = rotY; parent.add(g);
    box(1.5, 0.06, 0.75, M.white, 0, 0.75, 0, g);
    for (const sx of [-0.68, 0.68]) box(0.06, 0.75, 0.66, M.steel, sx, 0.375, 0, g);
    box(0.7, 0.44, 0.05, M.dark, 0, 1.08, -0.22, g);
    box(0.62, 0.36, 0.01, screens[Math.floor(rnd() * 3)], 0, 1.08, -0.19, g, false);
    box(0.5, 0.06, 0.5, M.dark, 0, 0.48, 0.72, g);              // chair
    box(0.5, 0.5, 0.06, M.dark, 0, 0.75, 0.96, g);
    const p = person(vestMats[Math.floor(rnd() * 4)], g);
    p.g.position.set(0, -0.4, 0.7);
    p.g.rotation.y = Math.PI;
    for (const l of p.legs) l.rotation.x = -Math.PI / 2;
    seated.push(p);
    return g;
  }
  function bench(parent: THREE.Object3D, x: number, z: number, w: number, laptops: number) {
    box(w, 0.1, 1.2, M.white, x, FLOOR + 0.95, z, parent);
    for (const sx of [-w / 2 + 0.15, w / 2 - 0.15]) for (const sz of [-0.5, 0.5]) box(0.08, 0.95, 0.08, M.steel, x + sx, FLOOR + 0.475, z + sz, parent);
    for (let i = 0; i < laptops; i++) {
      const lx = x - w / 2 + (w / laptops) * (i + 0.5);
      box(0.8, 0.05, 0.55, M.dark, lx, FLOOR + 1.03, z, parent);
      const lid = box(0.8, 0.52, 0.04, M.dark, lx, FLOOR + 1.29, z - 0.3, parent);
      lid.rotation.x = -0.2;
      box(0.7, 0.44, 0.01, screens[i % 3], lx, FLOOR + 1.29, z - 0.27, parent, false).rotation.x = -0.2;
    }
  }

  // ---------- repairs and clinic (sorting, charging, assessment) ----------
  bench(G.repairs, -30.6, -12.4, 4.4, 3);
  bench(G.repairs, -30.6, -9.4, 4.4, 3);
  worker(G.repairs, -30.0, -11.5, Math.PI);
  worker(G.repairs, -31.5, -8.5, Math.PI);
  box(0.12, 2.2, 5.4, M.steel, -33.2, FLOOR + 1.1, -11, G.repairs);
  box(0.06, 1.4, 4.8, M.blue, -33.1, FLOOR + 1.7, -11, G.repairs, false);
  const sparks = [box(0.08, 0.08, 0.08, M.amber, -29.8, FLOOR + 1.12, -12.3, G.repairs, false), box(0.08, 0.08, 0.08, M.amber, -31.4, FLOOR + 1.12, -9.3, G.repairs, false)];
  // charging carts with blinking lights
  const leds: THREE.Mesh[] = [];
  for (const [cx, cz] of [[-26.3, -13.8], [-24.4, -13.8], [-22.5, -13.8]] as const) {
    box(1.5, 1.6, 0.9, M.steel, cx, FLOOR + 0.8, cz, G.assessments);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 5; c++) leds.push(box(0.12, 0.08, 0.02, M.ledOn, cx - 0.5 + c * 0.25, FLOOR + 0.45 + r * 0.33, cz + 0.46, G.assessments, false));
  }
  bench(G.assessments, -21.2, -10.2, 5, 4);
  bench(G.assessments, -25.6, -9.6, 3.4, 2);
  worker(G.assessments, -21.6, -9.3, Math.PI);
  worker(G.assessments, -19.6, -9.3, Math.PI);
  worker(G.assessments, -25.4, -8.7, Math.PI);
  // sorting crates
  for (let i = 0; i < 4; i++) box(0.9, 0.5, 0.6, [M.blue, M.kraft, M.white, M.rose][i], -19.4 + i * 0.05, FLOOR + 0.25 + i * 0.5, -13.9, G.assessments);

  // ---------- picking & packing (left) ----------
  bench(G.picking, -15.6, -12.6, 3.0, 0);
  bench(G.picking, -12.4, -12.6, 3.0, 0);
  worker(G.picking, -15.6, -11.7, Math.PI);
  worker(G.picking, -12.4, -11.7, Math.PI);
  const packBoxes = [box(0.9, 0.55, 0.7, M.kraft, -15.6, FLOOR + 1.28, -12.6, G.picking), box(0.9, 0.55, 0.7, M.kraft, -12.4, FLOOR + 1.28, -12.6, G.picking)];
  palletStack(G.picking, -14, -9.9, 2);

  // ---------- staff entrance and security (audit) ----------
  function kiosk(parent: THREE.Object3D, x: number, z: number) {
    box(1.6, 2.3, 1.6, M.white, x, FLOOR + 1.15, z, parent);
    box(1.62, 0.8, 1.62, M.pane, x, FLOOR + 1.75, z, parent, false);
    box(1.8, 0.14, 1.8, M.dark, x, FLOOR + 2.37, z, parent);
    const beacon = box(0.24, 0.2, 0.24, M.beacon, x, FLOOR + 2.55, z, parent, false);
    return beacon;
  }
  const kioskLamps = [kiosk(G.audit, -2.4, -12.4), kiosk(G.audit, -31, -4.2), kiosk(G.audit, -31, 12.7)];
  // turnstile barrier the staff walk through
  box(0.3, 1.0, 0.3, M.dark, 0.2, FLOOR + 0.5, -12.4, G.audit);
  const barrier = new THREE.Group();
  barrier.position.set(0.2, FLOOR + 0.95, -12.4);
  box(2.0, 0.09, 0.09, M.rose, 1.0, 0, 0, barrier, false);
  G.audit.add(barrier);
  sign('STAFF ENTRANCE', 3.4, -0.6, FLOOR + 3.4, -15.2, G.audit);
  for (const s of [-1, 1]) box(0.16, 3.0, 0.16, M.steel, -0.6 + s * 1.6, FLOOR + 1.5, -15.2, G.audit);
  sign('SECURITY', 2.2, -31, FLOOR + 3.3, -3.2, G.audit, Math.PI / 2);

  // ---------- service block (notifications): canteen, lockers and a call bell ----------
  for (const [tx, tz] of [[4.2, -13.2], [6.8, -13.2], [4.2, -11.1], [6.8, -11.1]] as const) {
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 0.06, 24), M.white);
    top.position.set(tx, FLOOR + 0.75, tz); top.castShadow = true; G.notifications.add(top);
    box(0.1, 0.75, 0.1, M.steel, tx, FLOOR + 0.375, tz, G.notifications);
    for (const a of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) box(0.36, 0.45, 0.36, M.blue, tx + Math.cos(a) * 0.95, FLOOR + 0.225, tz + Math.sin(a) * 0.95, G.notifications);
  }
  for (let i = 0; i < 4; i++) box(0.7, 2.0, 0.6, i % 2 ? M.white : M.steel, 9.0 + (i % 2) * 0.75, FLOOR + 1.0, -14.0 + Math.floor(i / 2) * 0.7, G.notifications);
  worker(G.notifications, 5.5, -10.3, Math.PI);
  const bell = new THREE.Group();
  {
    const cup = new THREE.Mesh(new THREE.SphereGeometry(0.75, 24, 12, 0, Math.PI * 2, 0, Math.PI / 1.7), std('#ffb547', 0.35, 0.6));
    cup.castShadow = true; bell.add(cup);
    const lip = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.08, 10, 28), std('#ffb547', 0.35, 0.6));
    lip.rotation.x = Math.PI / 2; lip.position.y = -0.2; bell.add(lip);
    const clap = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), M.dark); clap.position.y = -0.35; bell.add(clap);
  }
  bell.position.set(6.6, FLOOR + 4.2, -12.2);
  G.notifications.add(bell);
  sign('SERVICE BLOCK', 3.2, 6.6, FLOOR + 2.7, -9.85, G.notifications);

  // ---------- PM & admin offices strip (users) ----------
  for (let i = 0; i < 6; i++) workstation(G.users, -3.4 + i * 2.9, -7.9, 0);

  // ---------- office column, west (settings) with a server rack ----------
  workstation(G.settings, -31, 2.0, Math.PI / 2);
  workstation(G.settings, -31, 4.6, Math.PI / 2);
  box(1.0, 2.2, 1.0, M.dark, -32.6, FLOOR + 1.1, 7.8, G.settings);
  for (let r = 0; r < 8; r++) leds.push(box(0.04, 0.06, 0.6, M.ledOn, -32.08, FLOOR + 0.4 + r * 0.22, 7.8, G.settings, false));
  workstation(G.settings, 32.4, -3.4, -Math.PI / 2);
  workstation(G.settings, 32.4, -0.4, -Math.PI / 2);
  workstation(G.settings, 32.4, 2.6, -Math.PI / 2);

  // ---------- binning racks ----------
  const LEVELS = [0, 1.7, 3.4, 5.1];
  function rack(parent: THREE.Object3D, x: number, z0: number, z1: number, beam: THREE.Material) {
    const len = z1 - z0, bays = Math.round(len / 2.6), bay = len / bays;
    for (let i = 0; i <= bays; i++) for (const sx of [-0.55, 0.55]) box(0.12, 6.9, 0.12, M.steel, x + sx, FLOOR + 3.45, z0 + i * bay, parent);
    for (const y of LEVELS.slice(1)) {
      for (const sx of [-0.55, 0.55]) box(0.09, 0.15, len, beam, x + sx, FLOOR + y - 0.08, (z0 + z1) / 2, parent);
      box(1.1, 0.04, len, M.deck, x, FLOOR + y - 0.02, (z0 + z1) / 2, parent, false);
    }
    const spots: { p: [number, number, number]; s: [number, number, number]; c: string }[] = [];
    for (let b = 0; b < bays; b++) for (const y of LEVELS) {
      if (rnd() < 0.18) continue;
      const zc = z0 + b * bay + bay / 2;
      for (const dz of [-0.55, 0.55]) {
        if (rnd() < 0.15) continue;
        const h = 0.55 + rnd() * 0.75, pick = rnd();
        spots.push({ p: [x, FLOOR + y + 0.02 + h / 2, zc + dz], s: [0.95, h, 0.95], c: tint[pick < 0.8 ? Math.floor(rnd() * 4) : pick < 0.92 ? 4 : 5] });
      }
    }
    const dummy = new THREE.Object3D();
    const im = new THREE.InstancedMesh(unitBox, std('#ffffff', 0.85), spots.length);
    const col = new THREE.Color();
    spots.forEach((s, i) => { dummy.position.set(...s.p); dummy.scale.set(...s.s); dummy.updateMatrix(); im.setMatrixAt(i, dummy.matrix); im.setColorAt(i, col.set(s.c)); });
    im.castShadow = im.receiveShadow = true;
    parent.add(im);
  }
  rack(G.binning, -14.8, -3.2, 10.2, M.blue);
  rack(G.binning, -10.0, -3.2, 10.2, M.blue);
  sign('BINNING', 2.8, -12.4, FLOOR + 7.6, 10.4, G.binning);
  rack(G.movements, 14.6, -3.2, 10.2, M.green);
  rack(G.movements, 18.6, -3.2, 10.2, M.green);
  sign('BINNING', 2.8, 16.6, FLOOR + 7.6, 10.4, G.movements, 0, '#5fae74');

  // ---------- pre-production: imaging tables ----------
  for (let r = 0; r < 4; r++) {
    bench(G.preproduction, -21, -0.4 + r * 3.6, 5.8, 5);
    if (r % 2 === 0) worker(G.preproduction, -22 + r * 0.3, 0.5 + r * 3.6, Math.PI);
  }
  sign('PRE-PRODUCTION', 3.6, -20.9, FLOOR + 3.4, 13.2, G.preproduction);

  // ---------- production: two conveyor lines with stations ----------
  const belts: { tex: THREE.Texture; parcels: THREE.Mesh[]; x0: number; len: number; speed: number }[] = [];
  function conveyor(parent: THREE.Object3D, x0: number, x1: number, z: number, speed: number) {
    const y = FLOOR + 1.0, len = x1 - x0, cx = (x0 + x1) / 2;
    const tex = canvasTex(64, 64, (g, w, h) => { g.fillStyle = '#2a3138'; g.fillRect(0, 0, w, h); g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(0, 0, 8, h); }, [len / 0.8, 1]);
    box(len, 0.16, 1.5, M.steel, cx, y - 0.06, z, parent);
    const belt = new THREE.Mesh(new THREE.PlaneGeometry(len, 1.2), std('#ffffff', 0.7, 0, { map: tex }));
    belt.rotation.x = -Math.PI / 2; belt.position.set(cx, y + 0.03, z); belt.receiveShadow = true; parent.add(belt);
    for (let x = x0 + 0.6; x < x1; x += 2.6) for (const dz of [-0.65, 0.65]) box(0.12, 1.0, 0.12, M.steel, x, FLOOR + 0.5, z + dz, parent);
    for (const ex of [x0, x1]) { box(1.4, 2.0, 1.9, M.dark, ex, FLOOR + 1.0, z, parent); box(1.44, 0.18, 1.94, M.blue, ex, FLOOR + 1.7, z, parent); }
    const parcels: THREE.Mesh[] = [];
    for (let i = 0; i < Math.round(len / 2.2); i++) {
      const s = 0.5 + rnd() * 0.3;
      parcels.push(box(s * 1.2, s, s, std(tint[i % 4], 0.85), x0, y + 0.05 + s / 2, z + (rnd() - 0.5) * 0.3, parent));
    }
    belts.push({ tex, parcels, x0, len, speed });
  }
  conveyor(G.production, -4.6, 10.6, 1.4, 1.1);
  conveyor(G.production, -4.6, 10.6, 8.4, 0.9);
  for (let i = 0; i < 5; i++) {
    worker(G.production, -2 + i * 3, 2.5, Math.PI);
    if (i % 2 === 0) worker(G.production, -1 + i * 3, 9.5, Math.PI);
  }
  for (let i = 0; i < 4; i++) bench(G.production, -1.4 + i * 3.6, 11.7, 2.6, 2);
  sign('PRODUCTION', 3.4, 2.4, FLOOR + 4.2, 5.0, G.production);

  // ---------- quarantine cage (discrepancies) ----------
  {
    const mesh = std('#5d6b76', 0.5, 0.6, { transparent: true, opacity: 0.35 });
    const [x0, x1, z0, z1] = ZONES.discrepancies.rects[0].r;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, w = x1 - x0 - 0.4, d = z1 - z0 - 0.3;
    box(w, 2.4, 0.05, mesh, cx, FLOOR + 1.2, cz - d / 2, G.discrepancies, false);
    box(w, 2.4, 0.05, mesh, cx, FLOOR + 1.2, cz + d / 2, G.discrepancies, false);
    box(0.05, 2.4, d, mesh, cx - w / 2, FLOOR + 1.2, cz, G.discrepancies, false);
    box(0.05, 2.4, d, mesh, cx + w / 2, FLOOR + 1.2, cz, G.discrepancies, false);
    box(w + 0.1, 0.08, 0.08, M.rose, cx, FLOOR + 2.4, cz - d / 2, G.discrepancies, false);
    for (let i = 0; i < 5; i++) box(0.8, 0.55, 0.6, i % 2 ? M.kraft : M.white, cx - 2.2 + i * 1.1, FLOOR + 0.28, cz, G.discrepancies);
  }
  const cageLight = box(0.3, 0.2, 0.3, M.rose, -20.2, FLOOR + 2.6, 13.9, G.discrepancies, false);
  sign('QUARANTINE', 2.6, -22.9, FLOOR + 3.4, 13.8, G.discrepancies, 0, '#e8857f');

  // ---------- right building: staging (picking & packing) for dispatch ----------
  palletStack(G.dispatch, 23.4, 0.9, 2);
  palletStack(G.dispatch, 25.8, 0.9, 1);
  palletStack(G.dispatch, 28.2, 2.8, 2);
  bench(G.dispatch, 27.6, -0.2, 3.0, 0);
  worker(G.dispatch, 27.6, 0.7, Math.PI);
  sign('PICKING & PACKING', 3.6, 25.9, FLOOR + 3.4, 4.6, G.dispatch);
  palletStack(G.dispatch, 23.6, -12.2, 2);
  palletStack(G.dispatch, 28.6, -12.2, 1);

  // ---------- offices outside, west: reports and invoicing ----------
  for (const [key, z0] of [['reports', -7.4], ['invoicing', 0.8]] as const) {
    const g = G[key];
    box(9.5, 0.25, 6.6, std('#e7f0f6', 0.9), -41.25, 0.125, z0 + 3.3, g, false);
    workstation(g, -43.6, z0 + 2.4, 0, 0.25);
    workstation(g, -40.6, z0 + 2.4, 0, 0.25);
    workstation(g, -43.6, z0 + 4.9, 0, 0.25);
  }
  sign('REPORTS', 2.6, -38.2, 3.8, -1.2, G.reports, Math.PI / 2);
  sign('INVOICING', 2.6, -38.2, 3.8, 6.8, G.invoicing, Math.PI / 2);
  // live bar chart for reports
  const chartBars: THREE.Mesh[] = [];
  for (let i = 0; i < 5; i++) chartBars.push(box(0.5, 1, 0.5, i % 2 ? M.blue : M.dark, -38.4, 0.25, -6 + i * 0.9, G.reports));
  // invoices printing for invoicing: a stack of paper that grows and a coin that spins
  box(0.8, 0.5, 0.6, M.dark, -38.6, 0.5, 2.0, G.invoicing);
  const paper = box(0.6, 0.02, 0.8, M.white, -38.6, 0.78, 2.0, G.invoicing);
  const coin = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.12, 32), std('#ffb547', 0.3, 0.8));
  coin.rotation.z = Math.PI / 2; coin.position.set(-38.6, 2.6, 4.6); coin.castShadow = true; G.invoicing.add(coin);

  // ---------- flow arrows on the floor (the numbered route on the plan) ----------
  const arrowTex = canvasTex(128, 64, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(240,138,126,.95)';
    g.beginPath(); g.moveTo(18, 10); g.lineTo(70, 32); g.lineTo(18, 54); g.lineTo(38, 32); g.closePath(); g.fill();
  });
  arrowTex.wrapS = THREE.RepeatWrapping;
  const arrowTexes: THREE.Texture[] = [];
  function flow(points: [number, number][]) {
    for (let i = 1; i < points.length; i++) {
      const [ax, az] = points[i - 1], [bx, bz] = points[i];
      const len = Math.hypot(bx - ax, bz - az);
      const t = arrowTex.clone(); t.needsUpdate = true; t.repeat.set(len / 1.1, 1); arrowTexes.push(t);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.6), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false }));
      m.rotation.x = -Math.PI / 2;
      m.rotation.z = Math.atan2(-(bz - az), bx - ax);
      m.position.set((ax + bx) / 2, FLOOR + 0.03, (az + bz) / 2);
      scene.add(m);
    }
  }
  flow([[-8.4, -10], [-8.4, -5.2], [-11.4, -5.2]]);                 // receiving -> binning
  flow([[-15.6, 11.8], [-16.6, 11.8]]);                              // binning -> pre-production
  flow([[-17.2, 13.0], [-8.6, 13.0]]);                               // pre-production -> production
  flow([[11.4, 12.4], [21.4, 12.4], [24.4, 4.8]]);                   // production -> picking & packing (right)
  flow([[26.1, -1.4], [26.1, -9.6]]);                                // picking & packing -> dispatch OUT
  flow([[18.3, -10], [16.6, -4.4]]);                                 // returns IN -> green binning
  flow([[-22.6, -7.4], [-22.6, -2.8]]);                              // clinic -> pre-production

  // ---------- vehicles ----------
  const brand = opts.brand.toUpperCase();
  const brandTex = canvasTex(1024, 320, (g, w, h) => {
    g.fillStyle = '#f4f7f9'; g.fillRect(0, 0, w, h);
    g.fillStyle = BLUE; g.fillRect(0, h - 46, w, 26);
    g.fillStyle = INK; g.fillRect(0, h - 20, w, 20);
    g.fillStyle = INK; g.font = '700 170px Outfit, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const tw = g.measureText(brand).width;
    if (tw > w - 80) g.font = `700 ${Math.floor(170 * ((w - 80) / tw))}px Outfit, system-ui, sans-serif`;
    g.fillText(brand, w / 2, h / 2 - 22);
  });
  const sideMat = std('#ffffff', 0.5, 0, { map: brandTex });
  interface Vehicle { g: THREE.Group; wheels: THREE.Group[]; r: number; route: Waypoint[]; cycle: number; off: number; lastX: number; lastZ: number; lights: THREE.Mesh[] }
  const vehicles: Vehicle[] = [];
  // front of every vehicle points along local +x
  function lorry(parent: THREE.Object3D, cab: THREE.Material) {
    const g = new THREE.Group();
    const trailer = new THREE.Mesh(unitBox, [M.white, M.white, M.white, M.white, sideMat, sideMat]);
    trailer.scale.set(9.5, 3.2, 2.5); trailer.position.set(-2.4, 2.35, 0); trailer.castShadow = true; g.add(trailer);
    box(9.5, 0.3, 2.1, M.dark, -2.4, 0.6, 0, g);
    box(2.3, 2.5, 2.45, cab, 3.6, 1.8, 0, g);
    box(2.32, 0.2, 2.47, M.blue, 3.6, 1.2, 0, g, false);
    box(0.06, 0.95, 2.1, M.glass, 4.77, 2.45, 0, g, false);
    const lights: THREE.Mesh[] = [];
    for (const s of [-1, 1]) {
      box(0.95, 0.75, 0.04, M.glass, 3.95, 2.45, 1.24 * s, g, false);
      lights.push(box(0.1, 0.2, 0.45, M.lamp, 4.78, 0.95, 0.8 * s, g, false));
      lights.push(box(0.06, 0.25, 0.35, M.red, -7.18, 0.9, 0.85 * s, g, false));
    }
    const wheels: THREE.Group[] = [];
    for (const x of [4.0, 1.6, -5.4, -6.5]) for (const s of [-1.1, 1.1]) wheels.push(wheel(0.5, 0.4, g, x, 0.5, s));
    parent.add(g);
    return { g, wheels, lights, r: 0.5 };
  }
  function van(parent: THREE.Object3D) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(unitBox, [M.white, M.white, M.white, M.white, sideMat, sideMat]);
    body.scale.set(3.6, 2.0, 1.9); body.position.set(-0.4, 1.45, 0); body.castShadow = true; g.add(body);
    box(1.3, 1.3, 1.9, M.white, 2.0, 1.1, 0, g);
    box(0.05, 0.6, 1.7, M.glass, 2.66, 1.5, 0, g, false);
    box(1.32, 0.14, 1.92, M.blue, 2.0, 0.6, 0, g, false);
    const lights: THREE.Mesh[] = [];
    for (const s of [-1, 1]) { lights.push(box(0.08, 0.16, 0.36, M.lamp, 2.66, 0.85, 0.65 * s, g, false)); lights.push(box(0.05, 0.22, 0.25, M.red, -2.22, 1.0, 0.75 * s, g, false)); }
    const wheels: THREE.Group[] = [];
    for (const x of [1.9, -1.4]) for (const s of [-0.9, 0.9]) wheels.push(wheel(0.4, 0.3, g, x, 0.4, s));
    parent.add(g);
    return { g, wheels, lights, r: 0.4 };
  }
  const EAST = -27, WEST = -29.5, FAR = 150, DOCKED = -22.6;
  // lorry delivering to receiving: arrives from the west, reverses onto the dock, unloads, leaves east
  vehicles.push({ ...lorry(G.receiving, M.dark), cycle: 56, off: 0, lastX: 0, lastZ: 0, route: [
    { p: [-FAR, EAST], t: 0 }, { p: [-8.4, EAST], t: 12 }, { p: [-8.4, EAST], t: 14 }, { p: [-8.4, DOCKED], t: 19, rev: true },
    { p: [-8.4, DOCKED], t: 34 }, { p: [-8.4, EAST], t: 38 }, { p: [-8.4, EAST], t: 39 }, { p: [FAR, EAST], t: 52 }, { p: [FAR, EAST], t: 56 },
  ] });
  // lorry bringing returns: arrives from the east on the far lane
  vehicles.push({ ...lorry(G.returns, std('#4c5b66', 0.55, 0.2)), cycle: 60, off: 21, lastX: 0, lastZ: 0, route: [
    { p: [FAR, WEST], t: 0 }, { p: [18.3, WEST], t: 11 }, { p: [18.3, WEST], t: 13 }, { p: [18.3, DOCKED], t: 18.5, rev: true },
    { p: [18.3, DOCKED], t: 36 }, { p: [18.3, WEST], t: 40 }, { p: [18.3, WEST], t: 41 }, { p: [-FAR, WEST], t: 55 }, { p: [-FAR, WEST], t: 60 },
  ] });
  // dispatch lorry: loads on the OUT dock, leaves, comes back later and reverses in again
  vehicles.push({ ...lorry(G.dispatch, M.dark), cycle: 64, off: 8, lastX: 0, lastZ: 0, route: [
    { p: [26.1, DOCKED], t: 0 }, { p: [26.1, DOCKED], t: 22 }, { p: [26.1, EAST], t: 26 }, { p: [26.1, EAST], t: 27 }, { p: [FAR, EAST], t: 38 },
    { p: [FAR, WEST], t: 42 }, { p: [26.1, WEST], t: 52 }, { p: [26.1, WEST], t: 54 }, { p: [26.1, DOCKED], t: 60, rev: true }, { p: [26.1, DOCKED], t: 64 },
  ] });
  // delivery vans: load in the van bay, drive out to schools, come back
  for (const [x, off] of [[31.6, 0], [34.4, 23]] as const) {
    vehicles.push({ ...van(G.delivery), cycle: 46, off, lastX: 0, lastZ: 0, route: [
      { p: [x, -19.2], t: 0 }, { p: [x, -19.2], t: 12 }, { p: [x, EAST], t: 15 }, { p: [x, EAST], t: 16 }, { p: [FAR, EAST], t: 26 },
      { p: [FAR, WEST], t: 28 }, { p: [x, WEST], t: 37 }, { p: [x, WEST], t: 38.5 }, { p: [x, -19.2], t: 43, rev: true }, { p: [x, -19.2], t: 46 },
    ] });
  }
  for (const x of [31.6, 34.4]) for (const s of [-1, 1]) flat(0.12, 6, M.lamp, x + s * 1.4, -19.6, 0.04, G.delivery);
  sign('DELIVERY VANS', 3.0, 33, 3.6, -16.2, G.delivery);
  for (const s of [-1, 1]) box(0.12, 3.6, 0.12, M.steel, 33 + s * 1.2, 1.8, -16.2, G.delivery);
  worker(G.delivery, 30.6, -16.8, Math.PI);

  // ---------- forklifts (stock movements) ----------
  function forklift(parent: THREE.Object3D, vest: THREE.Material) {
    const g = new THREE.Group();
    box(2.0, 0.9, 1.3, M.dark, -0.2, 0.75, 0, g);
    box(2.02, 0.12, 1.32, M.blue, -0.2, 1.08, 0, g, false);
    box(0.55, 0.75, 1.3, M.dark, -1.35, 0.82, 0, g);
    for (const [x, z] of [[0.5, -0.58], [0.5, 0.58], [-1.0, -0.58], [-1.0, 0.58]]) box(0.08, 1.55, 0.08, M.steel, x, 1.95, z, g);
    box(1.7, 0.08, 1.3, M.steel, -0.25, 2.72, 0, g);
    box(0.6, 0.45, 0.62, M.rubber, -0.5, 1.42, 0, g);
    box(0.3, 0.55, 0.44, vest, -0.42, 1.85, 0, g);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 14, 10), M.skin); head.position.set(-0.42, 2.27, 0); g.add(head);
    const beacon = box(0.16, 0.12, 0.16, M.amber, -0.9, 2.82, 0, g, false);
    const wheels: THREE.Group[] = [];
    for (const [x, z, r] of [[0.45, -0.7, 0.34], [0.45, 0.7, 0.34], [-1.05, -0.7, 0.28], [-1.05, 0.7, 0.28]]) wheels.push(wheel(r, 0.26, g, x, r, z));
    for (const s of [-0.42, 0.42]) box(0.13, 3.0, 0.1, M.steel, 0.95, 1.5, s, g);
    const carriage = new THREE.Group(); carriage.position.x = 1.08; g.add(carriage);
    box(0.06, 0.8, 1.0, M.steel, 0, 0.42, 0, carriage);
    for (const s of [-0.3, 0.3]) box(1.3, 0.06, 0.12, M.steel, 0.65, 0.03, s, carriage);
    box(1.25, 0.14, 1.2, M.wood, 0.68, 0.13, 0, carriage);
    box(1.12, 0.78, 1.08, M.kraft, 0.68, 0.59, 0, carriage);
    parent.add(g);
    return { g, wheels, beacon, carriage };
  }
  const lifts = [
    { ...forklift(G.movements, vestMats[3]), cycle: 34, off: 0, lastX: 0, lastZ: 0, liftAt: [12, 16] as [number, number], route: [
      { p: [-8.4, -11], t: 0 }, { p: [-8.4, -11], t: 2 }, { p: [-8.4, -5.6], t: 5 }, { p: [-12.4, -5.6], t: 7 }, { p: [-12.4, 4], t: 11 },
      { p: [-12.4, 4], t: 17 }, { p: [-12.4, 12.4], t: 20 }, { p: [-6.2, 12.4], t: 23 }, { p: [-6.2, 12.4], t: 25 }, { p: [-6.2, -5.6], t: 30 }, { p: [-8.4, -11], t: 34 },
    ] as Waypoint[] },
    { ...forklift(G.movements, vestMats[0]), cycle: 36, off: 9, lastX: 0, lastZ: 0, liftAt: [11, 15] as [number, number], route: [
      { p: [18.3, -11.5], t: 0 }, { p: [18.3, -11.5], t: 2 }, { p: [16.6, -5], t: 5 }, { p: [16.6, 5], t: 10 }, { p: [16.6, 5], t: 16 },
      { p: [16.6, 11.8], t: 19 }, { p: [21.2, 11.8], t: 21 }, { p: [24.6, 6.2], t: 24 }, { p: [24.6, 6.2], t: 26 }, { p: [26.1, -11.2], t: 31 }, { p: [18.3, -11.5], t: 36 },
    ] as Waypoint[] },
  ];

  // ---------- walking staff ----------
  const walkers = [
    { ...person(vestMats[1], G.users), route: [
      { p: [-0.6, -24], t: 0 }, { p: [-0.6, -15.4], t: 7 }, { p: [1.2, -12.4], t: 9.5 }, { p: [1.2, -9.4], t: 12 }, { p: [-5.6, -5.4], t: 18 },
      { p: [-18.4, -5.4], t: 28 }, { p: [-18.4, -5.4], t: 31 }, { p: [-5.6, -5.4], t: 41 }, { p: [1.2, -9.4], t: 47 }, { p: [1.2, -12.4], t: 49.5 }, { p: [-0.6, -15.4], t: 52 }, { p: [-0.6, -24], t: 59 },
    ] as Waypoint[], cycle: 60, off: 0, lastX: 0, lastZ: 0 },
    { ...person(vestMats[0], G.production), route: [
      { p: [-6.4, -1.4], t: 0 }, { p: [11.8, -1.4], t: 14 }, { p: [11.8, 5], t: 19 }, { p: [-6.4, 5], t: 33 }, { p: [-6.4, -1.4], t: 38 },
    ] as Waypoint[], cycle: 38, off: 0, lastX: 0, lastZ: 0 },
    { ...person(vestMats[2], G.movements), route: [
      { p: [21.2, -8], t: 0 }, { p: [21.2, 10], t: 13 }, { p: [29.8, 10], t: 19 }, { p: [29.8, -8], t: 32 }, { p: [21.2, -8], t: 38 },
    ] as Waypoint[], cycle: 38, off: 0, lastX: 0, lastZ: 0 },
    { ...person(vestMats[3], G.preproduction), route: [
      { p: [-17.6, -1.6], t: 0 }, { p: [-17.6, 12.4], t: 11 }, { p: [-24.2, 12.4], t: 16 }, { p: [-24.2, -1.6], t: 27 }, { p: [-17.6, -1.6], t: 32 },
    ] as Waypoint[], cycle: 32, off: 0, lastX: 0, lastZ: 0 },
  ];

  // ---------- dust in the light ----------
  const N = small ? 180 : 360;
  const dustPos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { dustPos[i * 3] = -34 + rnd() * 68; dustPos[i * 3 + 1] = rnd() * 9; dustPos[i * 3 + 2] = -15 + rnd() * 30; }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  scene.add(new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: '#ffffff', size: 0.1, transparent: true, opacity: 0.5, depthWrite: false })));

  // ---------- animation ----------
  const facing = new Map<object, number>();
  // front = the angle of the model's front from local +x (people face +z, so pass PI / 2)
  function drive(obj: { g: THREE.Group; lastX: number; lastZ: number }, route: Waypoint[], cycle: number, t: number, dt: number, front = 0) {
    const s = follow(route, cycle, t);
    const dist = Math.hypot(s.x - obj.lastX, s.z - obj.lastZ);
    const jumped = dist > 20;
    obj.g.position.x = s.x; obj.g.position.z = s.z;
    if (s.heading !== null) facing.set(obj, s.heading + front);
    const want = facing.get(obj) ?? 0;
    let d = want - obj.g.rotation.y; d = Math.atan2(Math.sin(d), Math.cos(d));
    obj.g.rotation.y += jumped ? d : d * Math.min(1, dt * 3.2);
    // signed distance along the heading, for the wheels
    const along = jumped ? 0 : (s.x - obj.lastX) * Math.cos(obj.g.rotation.y - front) - (s.z - obj.lastZ) * Math.sin(obj.g.rotation.y - front);
    obj.lastX = s.x; obj.lastZ = s.z;
    return { along, moving: s.moving, u: ((t % cycle) + cycle) % cycle };
  }
  function animate(t: number, dt: number) {
    for (const v of vehicles) {
      const { along } = drive(v, v.route, v.cycle, t + v.off, dt);
      for (const w of v.wheels) w.rotation.z -= along / v.r;
      const braking = Math.abs(along) < 0.001;
      for (const l of v.lights) if (l.material === M.red) l.scale.y = braking ? 1.4 : 1;
    }
    for (const f of lifts) {
      const { along, u } = drive(f, f.route, f.cycle, t + f.off, dt);
      for (const w of f.wheels) w.rotation.z -= along / 0.32;
      const [a, b] = f.liftAt;
      const k = u < a || u > b ? 0 : Math.sin(((u - a) / (b - a)) * Math.PI);
      f.carriage.position.y = 0.1 + k * 3.4;
      f.beacon.visible = Math.sin(t * 7 + f.off) > -0.2;
    }
    for (const w of walkers) {
      const { moving } = drive(w, w.route, w.cycle, t + w.off, dt, Math.PI / 2);
      const ph = (t + w.off) * 6.5;
      const a = moving ? 0.55 : 0;
      w.g.position.y = (w.g.position.z < -15.2 ? 0 : FLOOR) + (moving ? Math.abs(Math.sin(ph)) * 0.04 : 0);
      w.legs[0].rotation.x = Math.sin(ph) * a; w.legs[1].rotation.x = -Math.sin(ph) * a;
      w.arms[0].rotation.x = -Math.sin(ph) * a * 0.8; w.arms[1].rotation.x = Math.sin(ph) * a * 0.8;
    }
    workers.forEach((p, i) => {
      p.arms[0].rotation.x = -0.9 + Math.sin(t * 2.2 + i) * 0.35;
      p.arms[1].rotation.x = -0.9 + Math.sin(t * 2.2 + i + 1.4) * 0.35;
    });
    seated.forEach((p, i) => {
      p.arms[0].rotation.x = -1.05 + Math.sin(t * 9 + i) * 0.07;
      p.arms[1].rotation.x = -1.05 + Math.sin(t * 9 + i + 2) * 0.07;
      p.g.rotation.y = Math.PI + Math.sin(t * 0.4 + i * 1.7) * 0.18;
    });
    screens.forEach((m, i) => { m.emissiveIntensity = 0.45 + Math.sin(t * 1.6 + i * 2) * 0.2; });
    for (const b of belts) {
      b.tex.offset.x = -(t * b.speed) / 0.8;
      b.parcels.forEach((p, i) => { p.position.x = b.x0 + 0.8 + ((i * (b.len - 1.6)) / b.parcels.length + t * b.speed) % (b.len - 1.6); });
    }
    leds.forEach((l, i) => { l.material = Math.sin(t * (1.3 + (i % 5) * 0.4) + i * 1.9) > -0.35 ? M.ledOn : M.ledOff; });
    for (const s of sparks) s.visible = Math.sin(t * 23 + s.position.x) > 0.55;
    laser.visible = Math.sin(t * 31) > -0.2;
    laser.position.x = -4.8 + Math.sin(t * 2.4) * 0.6;
    packBoxes.forEach((b, i) => { b.scale.y = 0.55 * (1 + Math.max(0, Math.sin(t * 2.6 + i * 2)) * 0.12); });
    // the barrier lifts whenever someone walks through the staff entrance
    const near = Math.hypot(walkers[0].g.position.x - 1.2, walkers[0].g.position.z + 12.4) < 2.4;
    barrier.rotation.z += ((near ? 1.35 : 0) - barrier.rotation.z) * Math.min(1, dt * 4);
    bell.rotation.z = Math.sin(t * 7) * Math.max(0, Math.sin(t * 0.9)) * 0.35;
    bell.position.y = FLOOR + 4.2 + Math.sin(t * 1.3) * 0.15;
    chartBars.forEach((b, i) => { const h = 0.8 + (0.5 + 0.5 * Math.sin(t * 0.8 + i * 1.1)) * 2.2; b.scale.y = h; b.position.y = 0.25 + h / 2; });
    paper.scale.y = 1 + ((t * 2) % 12); paper.position.y = 0.76 + paper.scale.y * 0.01;
    coin.rotation.x = t * 2.2;
    coin.position.y = 2.6 + Math.sin(t * 1.5) * 0.2;
    for (const l of [...dockLamps, ...kioskLamps]) l.visible = Math.sin(t * 3 + l.position.x) > -0.4;
    cageLight.visible = Math.sin(t * 4) > -0.3;
    for (const t2 of arrowTexes) t2.offset.x = -t * 0.9;
    const arr = dustGeo.attributes.position.array as Float32Array;
    for (let i = 0; i < N; i++) {
      arr[i * 3 + 1] += dt * (0.12 + (i % 7) * 0.02);
      arr[i * 3] += Math.sin(t * 0.3 + i) * dt * 0.05;
      if (arr[i * 3 + 1] > 9) arr[i * 3 + 1] = 0;
    }
    dustGeo.attributes.position.needsUpdate = true;
  }

  // ---------- highlight: hovered and selected areas glow, their ring pulses ----------
  let hovered: ZoneKey | null = null;
  let selected: ZoneKey | null = null;
  let alerts = new Set<ZoneKey>();
  function paintZones(t: number) {
    for (const key of ZONE_KEYS) {
      const on = key === selected ? 0.45 : key === hovered ? 0.28 : 0;
      for (const m of padMats[key]) m.emissiveIntensity += (on - m.emissiveIntensity) * 0.2;
      const ring = rings[key];
      const mat = ring.material as THREE.MeshBasicMaterial;
      const pulse = (Math.sin(t * 2.2 + centers[key].x) + 1) / 2;
      const s = key === selected ? 1.6 + pulse * 0.4 : key === hovered ? 1.4 : 1 + pulse * 0.25;
      ring.scale.setScalar(s);
      mat.color.set(alerts.has(key) ? '#e8857f' : BLUE);
      mat.opacity = key === selected || key === hovered ? 0.95 : 0.35 + pulse * 0.3;
    }
  }

  // ---------- camera and controls ----------
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 14;
  controls.maxDistance = 150;
  controls.maxPolarAngle = 1.36;
  controls.screenSpacePanning = false;
  controls.autoRotate = !reduceMotion;
  controls.autoRotateSpeed = 0.35;
  const HOME = new THREE.Vector3(-4, 0, -4);
  function homePose() {
    const tall = camera.aspect < 1;
    const dist = tall ? 118 : 64 * Math.min(1.6, Math.max(1, 1.8 / camera.aspect));
    const dir = new THREE.Vector3(0.34, tall ? 1.05 : 0.74, 1).normalize();
    return { target: HOME.clone(), pos: HOME.clone().addScaledVector(dir, dist) };
  }
  // wheel zooms only with Ctrl / Cmd held, so the page still scrolls normally
  const onWheel = (e: WheelEvent) => { if (!e.ctrlKey && !e.metaKey) e.stopImmediatePropagation(); else e.preventDefault(); };
  renderer.domElement.addEventListener('wheel', onWheel, { capture: true, passive: false });
  let fly: { from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; k: number } | null = null;
  let idleTimer = 0;
  controls.addEventListener('start', () => { fly = null; controls.autoRotate = false; clearTimeout(idleTimer); });
  controls.addEventListener('end', () => {
    clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => { if (!selected && !reduceMotion) controls.autoRotate = true; }, 9000);
  });
  function flyTo(target: THREE.Vector3, pos: THREE.Vector3) {
    fly = { from: camera.position.clone(), to: pos, tFrom: controls.target.clone(), tTo: target, k: 0 };
  }
  function focus(z: ZoneKey | null) {
    if (!z) { const h = homePose(); flyTo(h.target, h.pos); if (!reduceMotion) controls.autoRotate = true; return; }
    controls.autoRotate = false;
    const c = centers[z].clone();
    const dist = Math.max(20, Math.min(46, sizes[z] * 2.4 + 12));
    const dir = camera.position.clone().sub(controls.target).setY(0);
    if (dir.lengthSq() < 0.01) dir.set(0.4, 0, 1);
    dir.normalize().multiplyScalar(dist * 0.78).setY(dist * 0.62);
    flyTo(c, c.clone().add(dir));
  }

  // ---------- picking ----------
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const pickables = ZONE_KEYS.filter((k) => enabled.has(k)).map((k) => G[k]);
  function zoneAt(cx: number, cy: number): ZoneKey | null {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(pickables, true)[0];
    let o: THREE.Object3D | null = hit?.object ?? null;
    while (o && !o.userData.zone) o = o.parent;
    return (o?.userData.zone as ZoneKey | undefined) ?? null;
  }
  let pointer: { x: number; y: number } | null = null;
  let down: { x: number; y: number } | null = null;
  const onMove = (e: PointerEvent) => { pointer = { x: e.clientX, y: e.clientY }; };
  const onLeave = () => { pointer = null; setHover(null); };
  const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
  const onUp = (e: PointerEvent) => {
    if (!down || e.button !== 0) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 6) return;
    const z = zoneAt(e.clientX, e.clientY);
    selected = z;
    focus(z);
    opts.onSelect(z);
  };
  function setHover(z: ZoneKey | null) {
    if (z === hovered) return;
    hovered = z;
    renderer.domElement.style.cursor = z ? 'pointer' : 'grab';
    opts.onHover?.(z);
  }
  renderer.domElement.addEventListener('pointermove', onMove);
  renderer.domElement.addEventListener('pointerleave', onLeave);
  renderer.domElement.addEventListener('pointerdown', onDown);
  renderer.domElement.addEventListener('pointerup', onUp);
  renderer.domElement.style.cursor = 'grab';

  // ---------- anchors for the HTML labels ----------
  const proj = new THREE.Vector3();
  function reportAnchors() {
    const w = host.clientWidth, h = host.clientHeight;
    const out: AnchorPositions = {};
    for (const key of ZONE_KEYS) {
      proj.set(centers[key].x, centers[key].y + 3.2, centers[key].z).project(camera);
      const x = ((proj.x + 1) / 2) * w, y = ((1 - proj.y) / 2) * h;
      out[key] = { x, y, visible: proj.z < 1 && x > 20 && x < w - 20 && y > 20 && y < h - 10 };
    }
    opts.onAnchors(out);
  }

  function resize() {
    const w = host.clientWidth || 1, h = host.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  {
    const h = homePose();
    camera.position.copy(h.pos);
    controls.target.copy(h.target);
    controls.update();
  }
  const ro = new ResizeObserver(() => resize());
  ro.observe(host);

  let last = performance.now();
  let clock = 9;
  let running = false;
  let stopped = false;
  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!reduceMotion) clock += dt;
    animate(clock, reduceMotion ? 0 : dt);
    if (fly) {
      fly.k = Math.min(1, fly.k + dt / 1.3);
      const k = ease(fly.k);
      camera.position.lerpVectors(fly.from, fly.to, k);
      controls.target.lerpVectors(fly.tFrom, fly.tTo, k);
      if (fly.k >= 1) fly = null;
    }
    controls.update(dt);
    const d = camera.position.distanceTo(controls.target);
    fog.near = d * 1.1; fog.far = d * 2.6;
    if (pointer && !down) setHover(zoneAt(pointer.x, pointer.y));
    paintZones(clock);
    renderer.render(scene, camera);
    reportAnchors();
  };
  const play = () => { if (running || stopped) return; running = true; last = performance.now(); renderer.setAnimationLoop(frame); };
  const pause = () => { running = false; renderer.setAnimationLoop(null); };
  const onVis = () => (document.hidden ? pause() : play());
  // pause while the stage is scrolled out of view
  const io = new IntersectionObserver(([e]) => (e.isIntersecting && !document.hidden ? play() : pause()));
  document.addEventListener('visibilitychange', onVis);
  io.observe(host);
  play();

  function stop() {
    stopped = true;
    pause();
    clearTimeout(idleTimer);
    io.disconnect();
    ro.disconnect();
    controls.dispose();
    document.removeEventListener('visibilitychange', onVis);
    renderer.domElement.removeEventListener('wheel', onWheel, { capture: true });
    renderer.domElement.removeEventListener('pointermove', onMove);
    renderer.domElement.removeEventListener('pointerleave', onLeave);
    renderer.domElement.removeEventListener('pointerdown', onDown);
    renderer.domElement.removeEventListener('pointerup', onUp);
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const m of mats) { const map = (m as THREE.MeshStandardMaterial).map; if (map) map.dispose(); m.dispose(); }
    });
    for (const t of arrowTexes) t.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }
  return {
    stop,
    select: (z) => { selected = z; focus(z); },
    setAlerts: (z) => { alerts = new Set(z); },
    zoom: (factor) => {
      fly = null; controls.autoRotate = false;
      const dir = camera.position.clone().sub(controls.target);
      const len = Math.min(controls.maxDistance, Math.max(controls.minDistance, dir.length() * factor));
      flyTo(controls.target.clone(), controls.target.clone().add(dir.setLength(len)));
    },
  };
}
