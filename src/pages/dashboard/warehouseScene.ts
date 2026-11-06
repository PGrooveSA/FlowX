// Dashboard stage: a live 3D warehouse built with Three.js (same look as the Stock Room Control App).
// Racks with BAY signs, forklifts picking pallets, people on the walkway, the issuing conveyor,
// a repair bench, a quarantine cage, the invoicing office and a lorry calling at the dispatch dock.
// Each area has an anchor point; the page projects the anchors to screen positions every frame
// so the HTML summary labels float over the matching part of the warehouse.
// With "reduce motion" switched on, one still frame is drawn. Without WebGL, start() returns null.
import * as THREE from 'three';

const BLUE = '#8ecff5';
const INK = '#1d1d1b';
const SKY = '#d6e4ee';

export type ZoneKey = 'work_orders' | 'stock' | 'issuing' | 'repairs' | 'discrepancies' | 'dispatch' | 'invoicing';
export type AnchorPositions = Partial<Record<ZoneKey, { x: number; y: number; visible: boolean }>>;

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
const seg = (t: number, a: number, b: number) => ease((t - a) / (b - a));

export interface WarehouseScene { stop: () => void }

export function startWarehouseScene(host: HTMLElement, opts: { brand: string; onAnchors: (a: AnchorPositions) => void }): WarehouseScene | null {
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
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 48, 115);
  const fog = scene.fog;
  const camera = new THREE.PerspectiveCamera(38, 1, 0.15, 260);
  const rnd = seeded(20261105);
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  // ---------- helpers ----------
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const std = (color: string, roughness = 0.8, metalness = 0.05, extra: THREE.MeshStandardMaterialParameters = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
  const M = {
    dark: std(INK, 0.55, 0.2),
    steel: std('#3a4652', 0.45, 0.55),
    deck: std('#9aa7b1', 0.6, 0.4),
    blue: std(BLUE, 0.45, 0.1),
    white: std('#f4f7f9', 0.55),
    wall: std('#e6edf2', 0.95),
    wood: std('#b88f5e', 0.9),
    kraft: std('#c9a27a', 0.85),
    rubber: std('#202326', 0.9),
    glass: std('#9fd6f7', 0.12, 0.4, { emissive: '#3c6f8f', emissiveIntensity: 0.25 }),
    pane: std('#bfe4fa', 0.1, 0.2, { transparent: true, opacity: 0.35 }),
    skin: std('#c9a585', 0.8),
    rose: std('#e8857f', 0.6),
    lamp: new THREE.MeshBasicMaterial({ color: '#eaf6ff' }),
    beacon: new THREE.MeshBasicMaterial({ color: BLUE }),
    screen: new THREE.MeshBasicMaterial({ color: '#bfe4fa' }),
  };
  function box(w: number, h: number, d: number, mat: THREE.Material | THREE.Material[], x: number, y: number, z: number, parent: THREE.Object3D, shadow = true) {
    const m = new THREE.Mesh(unitBox, mat);
    m.scale.set(w, h, d);
    m.position.set(x, y, z);
    m.castShadow = shadow;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }
  function wheel(r: number, w: number, parent: THREE.Object3D, x: number, y: number, z: number, axis: 'x' | 'z') {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, z);
    const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 18), M.rubber);
    if (axis === 'x') c.rotation.z = Math.PI / 2; else c.rotation.x = Math.PI / 2;
    c.castShadow = true;
    pivot.add(c);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.45, r * 0.45, w + 0.02, 10), M.deck);
    hub.rotation.copy(c.rotation);
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
  function sign(text: string, width: number, x: number, y: number, z: number, rotY = 0) {
    const px = Math.round(width * 180);
    const tex = canvasTex(px, 160, (g, w, h) => {
      roundRect(g, 0, 0, w, h, 26); g.fillStyle = INK; g.fill();
      g.fillStyle = BLUE; g.fillRect(36, h - 30, w - 72, 10);
      g.fillStyle = '#fff'; g.font = '600 80px Outfit, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      const tw = g.measureText(text).width;
      if (tw > w - 80) g.font = `600 ${Math.floor(80 * ((w - 80) / tw))}px Outfit, system-ui, sans-serif`;
      g.fillText(text, w / 2, h / 2 - 8);
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(width, width * (160 / px)), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
    m.position.set(x, y, z);
    m.rotation.y = rotY;
    scene.add(m);
    return m;
  }

  // ---------- light ----------
  scene.add(new THREE.HemisphereLight('#f1f8fd', '#93a8b6', 1.35));
  const sun = new THREE.DirectionalLight('#ffffff', 1.9);
  sun.position.set(22, 34, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(small ? 1024 : 2048, small ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -42, right: 42, top: 34, bottom: -34, near: 5, far: 110 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.07;
  scene.add(sun);

  // ---------- floor, walkway, road ----------
  const floorTex = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#e2eaf0'; g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(70,100,120,.10)'; g.lineWidth = 2; g.strokeRect(0, 0, w, h);
  }, [70, 50]);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(140, 100), std('#ffffff', 0.92, 0, { map: floorTex }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.z = -2;
  floor.receiveShadow = true;
  scene.add(floor);

  const flat = (w: number, d: number, mat: THREE.Material, x: number, z: number, y = 0.01) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
    m.rotation.x = -Math.PI / 2; m.position.set(x, y, z); m.receiveShadow = true; scene.add(m); return m;
  };
  const lineMat = std(BLUE, 0.6);
  flat(64, 0.14, lineMat, 0, 8.6, 0.02);
  flat(64, 0.14, lineMat, 0, 10.9, 0.02);
  for (const ax of [-18, -10, -2]) {
    flat(0.1, 19, lineMat, ax - 2.5, -6.5, 0.02);
    flat(0.1, 19, lineMat, ax + 2.5, -6.5, 0.02);
  }
  const roadTex = canvasTex(512, 128, (g, w, h) => {
    g.fillStyle = '#a9b6bf'; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,.85)'; g.fillRect(0, h / 2 - 3, w * 0.55, 6);
  }, [14, 1]);
  flat(140, 5.2, std('#ffffff', 1, 0, { map: roadTex }), 0, 14.6, 0.015);

  // ---------- back wall: work order office door and dock shutters ----------
  const WALL_Z = -18.4, DOOR_W = 3.4, DOOR_H = 3.6, DOOR_X = 0.6;
  const leftW = 33 + DOOR_X - DOOR_W / 2, rightW = 33 - DOOR_X - DOOR_W / 2;
  box(leftW, 9, 0.4, M.wall, -33 + leftW / 2, 4.5, WALL_Z, scene);
  box(rightW, 9, 0.4, M.wall, 33 - rightW / 2, 4.5, WALL_Z, scene);
  box(DOOR_W, 9 - DOOR_H, 0.4, M.wall, DOOR_X, DOOR_H + (9 - DOOR_H) / 2, WALL_Z, scene);
  for (const m of [
    box(0.34, DOOR_H + 0.3, 0.64, M.dark, DOOR_X - DOOR_W / 2 - 0.15, (DOOR_H + 0.3) / 2, WALL_Z + 0.1, scene, false),
    box(0.34, DOOR_H + 0.3, 0.64, M.dark, DOOR_X + DOOR_W / 2 + 0.15, (DOOR_H + 0.3) / 2, WALL_Z + 0.1, scene, false),
    box(DOOR_W + 0.64, 0.3, 0.64, M.dark, DOOR_X, DOOR_H + 0.13, WALL_Z + 0.1, scene, false),
  ]) m.receiveShadow = false;
  const doorMat = std('#d5dee5', 0.4, 0.5);
  for (const s of [-1, 1]) {
    const g = new THREE.Group();
    box(DOOR_W / 2, DOOR_H, 0.12, doorMat, 0, DOOR_H / 2, 0, g);
    box(0.05, DOOR_H * 0.8, 0.14, M.beacon, -s * (DOOR_W / 4 - 0.12), DOOR_H / 2, 0, g, false);
    g.traverse((o) => { o.castShadow = false; o.receiveShadow = false; });
    g.position.set(DOOR_X + (s * DOOR_W) / 4, 0, WALL_Z + 0.28);
    scene.add(g);
  }
  sign('WORK ORDERS', 4.275, DOOR_X, DOOR_H + 0.85, WALL_Z + 0.25);
  flat(0.1, 8, lineMat, DOOR_X, WALL_Z + 4.5, 0.02);
  box(66, 0.32, 0.44, M.blue, 0, 8.7, -18.4, scene);
  const shutter = std('#ffffff', 0.7, 0.2, { map: canvasTex(64, 256, (g, w, h) => {
    g.fillStyle = '#cfd9e0'; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(40,60,75,.18)'; for (let y = 0; y < h; y += 16) g.fillRect(0, y, w, 3);
  }) });
  for (const dx of [8, 16]) {
    box(3.8, 4.4, 0.1, shutter, dx, 2.2, -18.15, scene, false);
    box(4.2, 0.22, 0.2, M.dark, dx, 4.5, -18.1, scene, false);
    box(0.22, 4.6, 0.2, M.dark, dx - 2, 2.3, -18.1, scene, false);
    box(0.22, 4.6, 0.2, M.dark, dx + 2, 2.3, -18.1, scene, false);
    box(0.7, 0.18, 0.2, M.lamp, dx, 5.0, -18.1, scene, false);
  }

  // ---------- racks (instanced pallets and boxes) ----------
  const LEVELS = [0.02, 1.8, 3.55, 5.3];
  const RACK_X = [-22, -14, -6];
  const Z0 = -16, BAYS = 6, BAY = 3;
  const boxSpots: { p: [number, number, number]; s: [number, number, number]; c: string }[] = [];
  const palletSpots: [number, number, number][] = [];
  const tint = ['#c9a27a', '#d6b38b', '#b98d63', '#c29a70', '#e9eef2', BLUE];
  RACK_X.forEach((x0) => {
    for (let i = 0; i <= BAYS; i++) for (const sx of [-1.2, 1.2]) box(0.13, 7.3, 0.13, M.steel, x0 + sx, 3.65, Z0 + i * BAY, scene);
    for (const y of LEVELS.slice(1)) {
      for (const sx of [-1.2, 1.2]) box(0.1, 0.16, BAYS * BAY, M.blue, x0 + sx, y - 0.08, Z0 + (BAYS * BAY) / 2, scene);
      box(2.3, 0.04, BAYS * BAY, M.deck, x0, y - 0.03, Z0 + (BAYS * BAY) / 2, scene, false);
    }
    for (let b = 0; b < BAYS; b++) {
      for (const y of LEVELS) {
        if (rnd() < 0.16) continue;
        const zc = Z0 + b * BAY + BAY / 2;
        palletSpots.push([x0, y + 0.07, zc]);
        for (const dx of [-0.52, 0.52]) {
          for (const dz of [-0.66, 0.66]) {
            if (rnd() < 0.14) continue;
            const h = 0.6 + rnd() * 0.75;
            const pick = rnd();
            boxSpots.push({ p: [x0 + dx, y + 0.14 + h / 2, zc + dz], s: [0.98, h, 1.22], c: tint[pick < 0.78 ? Math.floor(rnd() * 4) : pick < 0.92 ? 4 : 5] });
          }
        }
      }
    }
  });
  // staging area: packed work orders waiting near the dock
  for (let i = 0; i < 9; i++) {
    const x = 7 + (i % 5) * 3.1 + rnd() * 0.4, z = 2.2 + Math.floor(i / 5) * 3.2 + rnd() * 0.4;
    palletSpots.push([x, 0.09, z]);
    const layers = 1 + Math.floor(rnd() * 3);
    for (let l = 0; l < layers; l++) {
      for (const dx of [-0.52, 0.52]) for (const dz of [-0.62, 0.62]) {
        boxSpots.push({ p: [x + dx, 0.16 + 0.42 + l * 0.84, z + dz], s: [0.98, 0.82, 1.16], c: tint[Math.floor(rnd() * 4)] });
      }
    }
  }
  const dummy = new THREE.Object3D();
  const pallets = new THREE.InstancedMesh(unitBox, M.wood, palletSpots.length);
  palletSpots.forEach(([x, y, z], i) => { dummy.position.set(x, y, z); dummy.scale.set(2.2, 0.14, 2.7); dummy.updateMatrix(); pallets.setMatrixAt(i, dummy.matrix); });
  const boxes = new THREE.InstancedMesh(unitBox, std('#ffffff', 0.85), boxSpots.length);
  const col = new THREE.Color();
  boxSpots.forEach((b, i) => {
    dummy.position.set(...b.p); dummy.scale.set(...b.s); dummy.updateMatrix();
    boxes.setMatrixAt(i, dummy.matrix); boxes.setColorAt(i, col.set(b.c));
  });
  for (const m of [pallets, boxes]) { m.castShadow = m.receiveShadow = true; scene.add(m); }
  RACK_X.forEach((x0, i) => {
    sign(`BAY ${'ABC'[i]}`, 2.8, x0, 8.05, Z0 + BAYS * BAY + 0.15);
    box(0.05, 0.6, 0.05, M.steel, x0 - 1, 7.95, Z0 + BAYS * BAY + 0.1, scene, false);
    box(0.05, 0.6, 0.05, M.steel, x0 + 1, 7.95, Z0 + BAYS * BAY + 0.1, scene, false);
  });

  // ---------- issuing conveyor ----------
  const CONV = { x0: 3.4, x1: 22.6, z: -3.2, y: 1.0 };
  const beltTex = canvasTex(64, 64, (g, w, h) => {
    g.fillStyle = '#2a3138'; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(0, 0, 8, h);
  }, [24, 1]);
  const beltLen = CONV.x1 - CONV.x0;
  const cx = (CONV.x0 + CONV.x1) / 2;
  box(beltLen, 0.16, 1.5, M.steel, cx, CONV.y - 0.06, CONV.z, scene);
  const belt = new THREE.Mesh(new THREE.PlaneGeometry(beltLen, 1.2), std('#ffffff', 0.7, 0, { map: beltTex }));
  belt.rotation.x = -Math.PI / 2; belt.position.set(cx, CONV.y + 0.03, CONV.z); belt.receiveShadow = true; scene.add(belt);
  for (let x = CONV.x0 + 1; x < CONV.x1; x += 3) for (const dz of [-0.65, 0.65]) box(0.12, CONV.y, 0.12, M.steel, x, CONV.y / 2, CONV.z + dz, scene);
  for (const ex of [CONV.x0, CONV.x1]) {
    box(1.8, 2.3, 2.0, M.dark, ex, 1.15, CONV.z, scene);
    box(1.84, 0.2, 2.04, M.blue, ex, 1.9, CONV.z, scene);
    box(0.4, 0.12, 0.1, M.beacon, ex, 2.05, CONV.z + 1.02, scene, false);
  }
  const parcels: THREE.Mesh[] = [];
  for (let i = 0; i < 8; i++) {
    const s = 0.55 + rnd() * 0.35;
    parcels.push(box(s * 1.2, s, s, std(tint[i % 4], 0.85), 0, CONV.y + 0.05 + s / 2, CONV.z + (rnd() - 0.5) * 0.3, scene));
  }

  // ---------- repair bench (right, back) ----------
  const RB = { x: 26.5, z: -11 };
  for (const dz of [-2.2, 2.2]) {
    box(5.2, 0.12, 1.6, M.white, RB.x, 1.0, RB.z + dz, scene);
    for (const [lx, lz] of [[-2.4, -0.65], [2.4, -0.65], [-2.4, 0.65], [2.4, 0.65]]) box(0.1, 1.0, 0.1, M.steel, RB.x + lx, 0.5, RB.z + dz + lz, scene);
    for (const lx of [-1.6, 0, 1.6]) {
      box(1.0, 0.06, 0.7, M.dark, RB.x + lx, 1.1, RB.z + dz, scene);                 // open laptop base
      const lid = box(1.0, 0.66, 0.05, M.dark, RB.x + lx, 1.43, RB.z + dz - 0.36, scene);
      lid.rotation.x = -0.18;
      box(0.88, 0.54, 0.01, M.screen, RB.x + lx, 1.43, RB.z + dz - 0.33, scene, false).rotation.x = -0.18;
    }
  }
  box(0.12, 2.2, 6.6, M.steel, RB.x + 3.2, 1.1, RB.z, scene);   // tool wall
  box(0.06, 1.4, 6.0, M.blue, RB.x + 3.13, 1.7, RB.z, scene, false);
  sign('REPAIRS', 3.2, RB.x, 4.6, RB.z + 3.4);

  // ---------- quarantine cage for discrepancies (left, front) ----------
  const QC = { x: -27.5, z: 3 };
  const mesh = std('#5d6b76', 0.5, 0.6, { transparent: true, opacity: 0.35 });
  box(6, 3, 0.06, mesh, QC.x, 1.5, QC.z + 2.5, scene, false);
  box(6, 3, 0.06, mesh, QC.x, 1.5, QC.z - 2.5, scene, false);
  box(0.06, 3, 5, mesh, QC.x - 3, 1.5, QC.z, scene, false);
  box(0.06, 3, 5, mesh, QC.x + 3, 1.5, QC.z, scene, false);
  for (const [px, pz] of [[-3, -2.5], [3, -2.5], [-3, 2.5], [3, 2.5]]) box(0.12, 3.1, 0.12, M.steel, QC.x + px, 1.55, QC.z + pz, scene);
  box(6.1, 0.1, 0.1, M.rose, QC.x, 3.05, QC.z + 2.5, scene, false);
  for (let i = 0; i < 4; i++) box(0.9, 0.6, 0.7, i % 2 ? M.kraft : M.white, QC.x - 1.6 + i * 1.1, 0.3, QC.z - 1 + (i % 2) * 1.4, scene);
  const cageLight = box(0.3, 0.2, 0.3, M.rose, QC.x + 2.8, 3.2, QC.z + 2.5, scene, false);
  sign('QUARANTINE', 3.2, QC.x, 4.1, QC.z + 2.6);

  // ---------- invoicing office: a glass booth (right, front) ----------
  const OF = { x: 27, z: 3 };
  box(6, 0.12, 5, M.white, OF.x, 0.06, OF.z, scene);
  box(6, 3.2, 0.08, M.pane, OF.x, 1.6, OF.z + 2.5, scene, false);
  box(0.08, 3.2, 5, M.pane, OF.x - 3, 1.6, OF.z, scene, false);
  box(6, 3.2, 0.12, M.wall, OF.x, 1.6, OF.z - 2.5, scene);
  box(0.12, 3.2, 5, M.wall, OF.x + 3, 1.6, OF.z, scene);
  box(6.2, 0.14, 5.2, M.dark, OF.x, 3.25, OF.z, scene);
  box(6.22, 0.1, 5.22, M.blue, OF.x, 3.1, OF.z, scene, false);
  for (const dx of [-1.3, 1.3]) {
    box(2.0, 0.08, 1.0, M.white, OF.x + dx, 0.9, OF.z - 0.6, scene);
    box(0.08, 0.9, 0.9, M.steel, OF.x + dx - 0.9, 0.45, OF.z - 0.6, scene);
    box(0.08, 0.9, 0.9, M.steel, OF.x + dx + 0.9, 0.45, OF.z - 0.6, scene);
    box(0.8, 0.5, 0.05, M.dark, OF.x + dx, 1.25, OF.z - 0.95, scene);
    box(0.72, 0.42, 0.01, M.screen, OF.x + dx, 1.25, OF.z - 0.92, scene, false);
  }
  sign('INVOICING', 3.2, OF.x, 4.0, OF.z + 2.6);

  // ---------- people ----------
  const vestMats = [std(BLUE, 0.7), std('#f4f7f9', 0.7), std('#4c5b66', 0.7)];
  function person(vest: THREE.Material) {
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
    scene.add(g);
    return { g, legs, arms };
  }
  type Walker = ReturnType<typeof person> & { a: [number, number]; b: [number, number]; speed: number; off: number };
  const walkers: Walker[] = [
    { ...person(vestMats[0]), a: [-25, 9.6], b: [25, 9.6], speed: 1.25, off: 0 },
    { ...person(vestMats[1]), a: [24, 10.2], b: [-24, 10.2], speed: 1.05, off: 17 },
    { ...person(vestMats[2]), a: [6, -1.4], b: [20, -1.4], speed: 0.85, off: 5 },
    { ...person(vestMats[0]), a: [7.5, 7.6], b: [21, 7.6], speed: 1.0, off: 9 },
  ];
  const packer = person(vestMats[1]);
  packer.g.position.set(21.2, 0, -1.7);
  packer.g.rotation.y = Math.PI;
  const techs = [person(vestMats[2]), person(vestMats[0])];
  techs[0].g.position.set(RB.x - 0.8, 0, RB.z - 1.2);
  techs[1].g.position.set(RB.x + 1.2, 0, RB.z + 3.2);
  techs[1].g.rotation.y = Math.PI;
  const clerk = person(vestMats[1]);
  clerk.g.position.set(OF.x - 1.3, 0, OF.z + 0.1);
  clerk.g.rotation.y = Math.PI;

  // ---------- forklifts ----------
  function forklift(i: number) {
    const g = new THREE.Group();
    box(1.3, 0.9, 2.0, M.dark, 0, 0.75, 0.2, g);
    box(1.32, 0.12, 2.02, M.blue, 0, 1.08, 0.2, g, false);
    box(1.3, 0.75, 0.55, M.dark, 0, 0.82, 1.35, g);
    for (const [x, z] of [[-0.58, -0.5], [0.58, -0.5], [-0.58, 1.0], [0.58, 1.0]]) box(0.08, 1.55, 0.08, M.steel, x, 1.95, z, g);
    box(1.3, 0.08, 1.7, M.steel, 0, 2.72, 0.25, g);
    box(0.62, 0.45, 0.6, M.rubber, 0, 1.42, 0.5, g);
    box(0.44, 0.55, 0.3, vestMats[i % 3], 0, 1.85, 0.42, g);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 14, 10), M.skin); head.position.set(0, 2.27, 0.42); g.add(head);
    const beacon = box(0.16, 0.12, 0.16, M.beacon, 0, 2.82, 0.9, g, false);
    const wheels: THREE.Group[] = [];
    for (const [x, z, r] of [[-0.7, -0.45, 0.34], [0.7, -0.45, 0.34], [-0.7, 1.05, 0.28], [0.7, 1.05, 0.28]]) wheels.push(wheel(r, 0.26, g, x, r, z, 'x'));
    for (const s of [-0.42, 0.42]) box(0.1, 3.0, 0.13, M.steel, s, 1.5, -0.95, g);
    const inner = new THREE.Group(); g.add(inner);
    for (const s of [-0.3, 0.3]) box(0.08, 3.0, 0.1, M.deck, s, 1.6, -1.02, inner);
    const carriage = new THREE.Group(); carriage.position.z = -1.08; g.add(carriage);
    box(1.0, 0.8, 0.06, M.steel, 0, 0.42, 0, carriage);
    for (const s of [-0.3, 0.3]) box(0.12, 0.06, 1.3, M.steel, s, 0.03, -0.65, carriage);
    box(1.2, 0.14, 1.25, M.wood, 0, 0.13, -0.68, carriage);
    box(1.08, 0.78, 1.12, M.kraft, 0, 0.59, -0.68, carriage);
    box(0.5, 0.36, 0.5, std(BLUE, 0.8), 0.22, 1.16, -0.48, carriage);
    scene.add(g);
    return { g, inner, carriage, wheels, beacon, lastZ: 0 };
  }
  const lifts = [-18, -10, -2].map((x, i) => ({ ...forklift(i), x, off: i * 6.1, side: -1 }));
  const CYCLE = 18;

  // ---------- the dispatch lorry ----------
  const truck = new THREE.Group();
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
  const trailer = new THREE.Mesh(unitBox, [M.white, M.white, M.white, M.white, sideMat, sideMat]);
  trailer.scale.set(11, 3.4, 2.6); trailer.position.set(-3.2, 2.45, 0); trailer.castShadow = true; truck.add(trailer);
  box(11, 0.3, 2.2, M.dark, -3.2, 0.62, 0, truck);
  box(2.4, 2.6, 2.5, M.dark, 3.7, 1.85, 0, truck);
  box(2.42, 0.2, 2.52, M.blue, 3.7, 1.25, 0, truck, false);
  box(0.06, 1.0, 2.2, M.glass, 4.92, 2.5, 0, truck, false);
  for (const s of [-1, 1]) {
    box(1.0, 0.8, 0.04, M.glass, 4.05, 2.5, 1.26 * s, truck, false);
    box(0.12, 0.2, 0.5, M.lamp, 4.93, 0.95, 0.85 * s, truck, false);
  }
  const truckWheels: THREE.Group[] = [];
  for (const x of [4.2, 1.7, -6.6, -7.75]) for (const s of [-1.12, 1.12]) truckWheels.push(wheel(0.52, 0.42, truck, x, 0.52, s, 'z'));
  truck.position.set(-80, 0, 14.6);
  scene.add(truck);
  let truckLastX = truck.position.x;
  const TRUCK_CYCLE = 34;
  function truckX(t: number) {
    const u = t % TRUCK_CYCLE;
    if (u < 10) return -75 + 77 * (1 - (1 - u / 10) ** 2);
    if (u < 15) return 2;
    if (u < 25) return 2 + 78 * ((u - 15) / 10) ** 2;
    return 90;
  }
  sign('DISPATCH', 3.2, 11, 4.6, 11.6);
  box(0.08, 4.6, 0.08, M.steel, 9.6, 2.3, 11.6, scene);
  box(0.08, 4.6, 0.08, M.steel, 12.4, 2.3, 11.6, scene);

  // ---------- dust in the light ----------
  const N = small ? 160 : 320;
  const dustPos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { dustPos[i * 3] = (rnd() - 0.5) * 60; dustPos[i * 3 + 1] = rnd() * 10; dustPos[i * 3 + 2] = -18 + rnd() * 32; }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  scene.add(new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: '#ffffff', size: 0.09, transparent: true, opacity: 0.55, depthWrite: false })));

  // ---------- anchors for the summary labels ----------
  const anchors: Record<ZoneKey, THREE.Vector3> = {
    work_orders: new THREE.Vector3(DOOR_X, 6.4, WALL_Z + 0.3),
    stock: new THREE.Vector3(-14, 9.4, Z0 + BAYS * BAY),
    issuing: new THREE.Vector3(13, 3.2, CONV.z),
    repairs: new THREE.Vector3(RB.x, 5.6, RB.z + 3.4),
    discrepancies: new THREE.Vector3(QC.x, 5.1, QC.z + 2.6),
    invoicing: new THREE.Vector3(OF.x, 5.0, OF.z + 2.6),
    dispatch: new THREE.Vector3(11, 5.5, 11.6),
  };
  const proj = new THREE.Vector3();
  function reportAnchors() {
    const w = host.clientWidth, h = host.clientHeight;
    const out: AnchorPositions = {};
    for (const [k, v] of Object.entries(anchors) as [ZoneKey, THREE.Vector3][]) {
      proj.copy(v).project(camera);
      const x = ((proj.x + 1) / 2) * w, y = ((1 - proj.y) / 2) * h;
      out[k] = { x, y, visible: proj.z < 1 && x > 40 && x < w - 40 && y > 24 && y < h - 16 };
    }
    opts.onAnchors(out);
  }

  // ---------- animation ----------
  function animate(t: number, dt: number) {
    for (const f of lifts) {
      const lt = (t + f.off) % CYCLE;
      const cycle = Math.floor((t + f.off) / CYCLE);
      const bay = (cycle * 3 + Math.round(f.off)) % 5;
      const zt = Z0 + bay * BAY + BAY / 2 + 0.6;
      const h = LEVELS[1 + ((cycle + bay) % 3)];
      const zin = 7 + (zt - 7) * seg(lt, 0, 4);
      const z = lt < 11.8 ? zin : zt + (7 - zt) * seg(lt, 11.8, 15.8);
      const turn = seg(lt, 4, 5.2) - seg(lt, 10.6, 11.8);
      const lift = 0.15 + (h + 0.05 - 0.15) * (seg(lt, 5.2, 7.4) - seg(lt, 8.4, 10.6));
      f.g.position.set(f.x, 0, z);
      f.g.rotation.y = f.side * -turn * (Math.PI / 2);
      f.carriage.position.y = lift;
      f.inner.position.y = Math.max(0, lift - 1.5);
      const dz = z - f.lastZ; f.lastZ = z;
      for (const w of f.wheels) w.rotation.x += dz / 0.32;
      f.beacon.visible = Math.sin(t * 6 + f.off) > -0.2;
    }
    for (const w of walkers) {
      const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
      const u = (((t + w.off) * w.speed) / len) % 2;
      const k = u < 1 ? u : 2 - u;
      const x = w.a[0] + (w.b[0] - w.a[0]) * k, z = w.a[1] + (w.b[1] - w.a[1]) * k;
      const dir = u < 1 ? Math.atan2(w.b[0] - w.a[0], w.b[1] - w.a[1]) : Math.atan2(w.a[0] - w.b[0], w.a[1] - w.b[1]);
      let d = dir - w.g.rotation.y; d = Math.atan2(Math.sin(d), Math.cos(d));
      w.g.rotation.y += d * Math.min(1, dt * 6);
      const ph = (t + w.off) * w.speed * 5.2;
      w.g.position.set(x, Math.abs(Math.sin(ph)) * 0.04, z);
      w.legs[0].rotation.x = Math.sin(ph) * 0.55; w.legs[1].rotation.x = -Math.sin(ph) * 0.55;
      w.arms[0].rotation.x = -Math.sin(ph) * 0.45; w.arms[1].rotation.x = Math.sin(ph) * 0.45;
    }
    for (const [i, p] of [packer, ...techs, clerk].entries()) {
      p.arms[0].rotation.x = -0.9 + Math.sin(t * 2.2 + i) * 0.35;
      p.arms[1].rotation.x = -0.9 + Math.sin(t * 2.2 + i + 1.4) * 0.35;
    }
    beltTex.offset.x = -(t * 1.1 * 24) / beltLen;
    parcels.forEach((p, i) => { p.position.x = CONV.x0 + ((i * beltLen) / parcels.length + t * 1.1) % beltLen; });
    const tx = truckX(t + 6);
    truck.position.x = tx;
    const dx = tx - truckLastX; truckLastX = tx;
    if (Math.abs(dx) < 5) for (const w of truckWheels) w.rotation.z -= dx / 0.52;
    cageLight.visible = Math.sin(t * 4) > -0.3;
    const arr = dustGeo.attributes.position.array as Float32Array;
    for (let i = 0; i < N; i++) {
      arr[i * 3 + 1] += dt * (0.12 + (i % 7) * 0.02);
      arr[i * 3] += Math.sin(t * 0.3 + i) * dt * 0.05;
      if (arr[i * 3 + 1] > 10) arr[i * 3 + 1] = 0;
    }
    dustGeo.attributes.position.needsUpdate = true;
  }

  // camera: slow drift plus a little pointer parallax
  const target = new THREE.Vector3(1.5, 0.5, -3);
  const ptr = { x: 0, y: 0, sx: 0, sy: 0 };
  const onPointer = (e: PointerEvent) => { ptr.x = e.clientX / innerWidth - 0.5; ptr.y = e.clientY / innerHeight - 0.5; };
  addEventListener('pointermove', onPointer, { passive: true });
  function placeCamera(t: number, dt: number) {
    ptr.sx += (ptr.x - ptr.sx) * Math.min(1, dt * 2.5);
    ptr.sy += (ptr.y - ptr.sy) * Math.min(1, dt * 2.5);
    const aspect = camera.aspect;
    const tall = aspect < 1;
    const dist = tall ? 52 : 41 * Math.min(1.6, Math.max(1, 2.3 / aspect));
    const ang = Math.sin(t * 0.055) * (tall ? 0.35 : 0.22) + ptr.sx * 0.12;
    const hgt = (tall ? 46 : 22) + Math.sin(t * 0.04) * 1.5 - ptr.sy * 3;
    camera.position.set(target.x + Math.sin(ang) * dist, hgt * (tall ? 1 : dist / 41), target.z + Math.cos(ang) * dist);
    camera.lookAt(target);
    const d = camera.position.distanceTo(target);
    fog.near = d * 0.85;
    fog.far = d * 2.1;
  }

  function resize() {
    const w = host.clientWidth || 1, h = host.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  const ro = new ResizeObserver(() => {
    resize();
    if (!running) { placeCamera(clock, 1); renderer.render(scene, camera); reportAnchors(); }
  });
  ro.observe(host);

  let last = performance.now();
  let clock = 9;
  let running = false;
  let stopped = false;
  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    clock += dt;
    animate(clock, dt);
    placeCamera(clock, dt);
    renderer.render(scene, camera);
    reportAnchors();
  };
  const play = () => { if (running || stopped) return; running = true; last = performance.now(); renderer.setAnimationLoop(frame); };
  const pause = () => { running = false; renderer.setAnimationLoop(null); };
  const onVis = () => (document.hidden ? pause() : play());
  // pause while the stage is scrolled out of view
  const io = new IntersectionObserver(([e]) => (e.isIntersecting && !document.hidden ? play() : pause()));

  if (reduceMotion) {
    animate(clock, 0); placeCamera(clock, 1); renderer.render(scene, camera); reportAnchors();
  } else {
    document.addEventListener('visibilitychange', onVis);
    io.observe(host);
    play();
  }

  function stop() {
    stopped = true;
    pause();
    io.disconnect();
    ro.disconnect();
    document.removeEventListener('visibilitychange', onVis);
    removeEventListener('pointermove', onPointer);
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const m of mats) { const map = (m as THREE.MeshStandardMaterial).map; if (map) map.dispose(); m.dispose(); }
    });
    renderer.dispose();
    renderer.domElement.remove();
  }
  return { stop };
}
