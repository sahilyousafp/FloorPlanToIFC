import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildIfc } from './ifc.js';
import { CLASSES, footprint, metersPerPx, verticalExtent } from './layout.js';

// Openings are drawn slightly larger than walls so they stay visible through them.
const OPENING_INFLATE_M = 0.03;

const $ = (id) => document.getElementById(id);
const ui = {
  drop: $('drop'),
  file: $('file'),
  dropTitle: $('drop-title'),
  dropHint: $('drop-hint'),
  detect: $('detect'),
  status: $('status'),
  results: $('results'),
  viewSection: $('view-section'),
  confidence: $('confidence'),
  confidenceValue: $('confidence-value'),
  wallHeight: $('wall-height'),
  wallHeightValue: $('wall-height-value'),
  showPlan: $('show-plan'),
  exportIfc: $('export-ifc'),
  exportSection: $('export-section'),
  meta: $('meta'),
  stage: $('stage'),
  empty: $('empty'),
  tooltip: $('tooltip'),
};

const state = {
  canvas: null,       // decoded plan image, shared by the upload and the texture
  detections: [],     // last detection result, in pixels
  fileName: '',
  view: '3d',
  busy: false,        // true while a file is decoding or a detection is running
  metersPerPx: 1,
  width: 0,
  height: 0,
};

// ---------------------------------------------------------------- scene setup

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
ui.stage.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(-0.6, 1, 0.4);
scene.add(sun);

const perspective = new THREE.PerspectiveCamera(45, 1, 0.05, 2000);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 2000);
ortho.up.set(0, 0, -1); // image top points up the screen in the top view

const controls3d = new OrbitControls(perspective, renderer.domElement);
controls3d.enableDamping = true;
controls3d.maxPolarAngle = Math.PI / 2 - 0.02;

const controls2d = new OrbitControls(ortho, renderer.domElement);
controls2d.enableRotate = false;
controls2d.screenSpacePanning = true;
controls2d.enabled = false;

const planGroup = new THREE.Group();
const classGroups = Object.fromEntries(CLASSES.map((c) => [c, new THREE.Group()]));
scene.add(planGroup, ...Object.values(classGroups));

const materials = {};
const edgeMaterials = {};

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function createMaterials() {
  materials.wall = new THREE.MeshStandardMaterial({ roughness: 0.85, transparent: true });
  materials.door = new THREE.MeshStandardMaterial({ roughness: 0.6, transparent: true, opacity: 0.55, depthWrite: false });
  materials.window = new THREE.MeshStandardMaterial({ roughness: 0.2, transparent: true, opacity: 0.45, depthWrite: false });
  for (const c of CLASSES) edgeMaterials[c] = new THREE.LineBasicMaterial({ transparent: true });
  applyTheme();
}

function applyTheme() {
  scene.background = new THREE.Color(cssVar('--scene'));
  for (const c of CLASSES) {
    const color = new THREE.Color(cssVar(`--${c}`));
    materials[c].color.copy(color);
    edgeMaterials[c].color.copy(color).multiplyScalar(c === 'wall' ? 0.55 : 0.8);
  }
}

createMaterials();
applyView();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ---------------------------------------------------------------- image input

ui.file.addEventListener('change', () => {
  if (ui.file.files[0]) loadFile(ui.file.files[0]);
});

for (const type of ['dragenter', 'dragover']) {
  ui.drop.addEventListener(type, (e) => {
    e.preventDefault();
    ui.drop.classList.add('dragging');
  });
}
for (const type of ['dragleave', 'drop']) {
  ui.drop.addEventListener(type, () => ui.drop.classList.remove('dragging'));
}
ui.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
});

async function loadFile(file) {
  if (state.busy) return;
  if (!file.type.startsWith('image/')) {
    setStatus(`"${file.name}" is not an image.`, true);
    return;
  }
  setBusy(true);
  try {
    await decodeFile(file);
  } catch {
    setStatus(`Could not decode "${file.name}".`, true);
  } finally {
    setBusy(false);
  }
}

async function decodeFile(file) {
  // Decode once in the browser (honoring EXIF orientation) so the model sees
  // exactly the pixels the texture shows, and bounding boxes line up.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  // Flatten transparency onto white, the way paper plans look.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  state.canvas = canvas;
  state.fileName = file.name;
  ui.dropTitle.textContent = file.name;
  ui.dropHint.textContent = `${canvas.width} × ${canvas.height} px · click to replace`;
  ui.results.hidden = true;
  ui.exportSection.hidden = true;
  setStatus('');

  clearDetections();
  setupPlan(canvas, 0);
  ui.viewSection.hidden = false;
  renderMeta(null);
}

// ---------------------------------------------------------------- detection

ui.detect.addEventListener('click', runDetection);

async function runDetection() {
  if (!state.canvas || state.busy) return;
  setBusy(true);
  ui.detect.classList.add('busy');
  setStatus('Running Mask R-CNN. The first request also loads the model, which can take a minute.');

  try {
    const blob = await new Promise((resolve) => state.canvas.toBlob(resolve, 'image/png'));
    const body = new FormData();
    body.append('image', blob, state.fileName.replace(/\.[^.]+$/, '') + '.png');

    let response;
    try {
      response = await fetch('/', { method: 'POST', body });
    } catch {
      throw new Error('Could not reach the API. Is application.py running?');
    }
    if (!response.ok) throw new Error(`Detection failed (HTTP ${response.status}). Check the server log.`);

    const data = await response.json();
    const detections = data.points.map((p, i) => ({
      cls: data.classes[i].name,
      score: data.scores ? data.scores[i] : 1,
      ...p,
    }));
    showDetections(data, detections);
    setStatus('');
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    ui.detect.classList.remove('busy');
    setBusy(false);
  }
}

function showDetections(data, detections) {
  clearDetections();
  state.detections = detections;
  setupPlan(state.canvas, data.averageDoor);

  for (const d of detections) {
    if (!classGroups[d.cls]) continue;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), materials[d.cls]);
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), edgeMaterials[d.cls]));
    mesh.userData.detection = d;
    classGroups[d.cls].add(mesh);
  }
  layoutMeshes();

  for (const c of CLASSES) {
    ui.results.querySelector(`[data-count="${c}"]`).textContent = classGroups[c].children.length;
  }
  ui.results.hidden = false;
  ui.exportSection.hidden = false;
  applyFilters();
  renderMeta(data);
}

// Positions every detection box from its pixel bbox and the current wall height.
function layoutMeshes() {
  const wallHeight = Number(ui.wallHeight.value);
  const flat = state.view === '2d';

  for (const c of CLASSES) {
    for (const mesh of classGroups[c].children) {
      const inflate = c === 'wall' ? 0 : OPENING_INFLATE_M;
      let { bottom, top } = verticalExtent(c, wallHeight);
      if (flat) {
        // In the top view every class is a thin slab, so later classes draw over walls.
        bottom = 0.01 + CLASSES.indexOf(c) * 0.01;
        top = bottom + 0.005;
      }
      const f = footprint(mesh.userData.detection, state);
      mesh.scale.set(f.sx + inflate, top - bottom, f.sy + inflate);
      mesh.position.set(f.cx, (bottom + top) / 2, f.cy);
    }
  }
}

function setupPlan(canvas, averageDoor) {
  disposeGroup(planGroup);
  state.width = canvas.width;
  state.height = canvas.height;
  state.metersPerPx = metersPerPx(averageDoor, canvas.width);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(canvas.width * state.metersPerPx, canvas.height * state.metersPerPx),
    new THREE.MeshBasicMaterial({ map: texture }),
  );
  plane.rotation.x = -Math.PI / 2;
  planGroup.add(plane);
  planGroup.visible = ui.showPlan.checked;

  ui.empty.hidden = true;
  frameCameras();
}

function clearDetections() {
  for (const c of CLASSES) disposeGroup(classGroups[c]);
  state.detections = [];
  ui.exportIfc.disabled = true;
  hideTooltip();
}

function disposeGroup(group) {
  for (const child of [...group.children]) {
    child.traverse((o) => {
      o.geometry?.dispose();
      // Class materials are shared and reused; only the plan owns its material.
      if (group === planGroup && o.material) {
        o.material.map?.dispose();
        o.material.dispose();
      }
    });
    group.remove(child);
  }
}

// ---------------------------------------------------------------- controls

for (const input of ui.results.querySelectorAll('[data-class]')) {
  input.addEventListener('change', applyFilters);
}
ui.confidence.addEventListener('input', applyFilters);

function applyFilters() {
  const min = Number(ui.confidence.value);
  ui.confidenceValue.textContent = min.toFixed(2);
  for (const c of CLASSES) {
    classGroups[c].visible = ui.results.querySelector(`[data-class="${c}"]`).checked;
    for (const mesh of classGroups[c].children) mesh.visible = mesh.userData.detection.score >= min;
  }
  ui.exportIfc.disabled = visibleDetections().length === 0;
  hideTooltip();
}

// Detections that pass the class toggles and confidence filter, i.e. what is on screen.
function visibleDetections() {
  const min = Number(ui.confidence.value);
  return state.detections.filter((d) => d.score >= min
    && ui.results.querySelector(`[data-class="${d.cls}"]`)?.checked);
}

ui.exportIfc.addEventListener('click', () => {
  const ifc = buildIfc({
    name: state.fileName,
    detections: visibleDetections(),
    plan: state,
    wallHeight: Number(ui.wallHeight.value),
  });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([ifc], { type: 'application/x-step' }));
  link.download = `${state.fileName.replace(/\.[^.]+$/, '')}.ifc`;
  link.click();
  // Revoke on the next tick; revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(link.href));
});

ui.wallHeight.addEventListener('input', () => {
  ui.wallHeightValue.textContent = `${Number(ui.wallHeight.value).toFixed(1)} m`;
  layoutMeshes();
});

ui.showPlan.addEventListener('change', () => {
  planGroup.visible = ui.showPlan.checked;
});

for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => {
    state.view = button.dataset.view;
    applyView();
  });
}

function applyView() {
  const flat = state.view === '2d';
  for (const button of document.querySelectorAll('[data-view]')) {
    button.setAttribute('aria-checked', String(button.dataset.view === state.view));
  }
  controls3d.enabled = !flat;
  controls2d.enabled = flat;
  materials.wall.opacity = flat ? 0.45 : 1;
  materials.wall.depthWrite = !flat;
  ui.wallHeight.disabled = flat;
  layoutMeshes();
  hideTooltip();
}

function planSize() {
  return {
    w: state.width * state.metersPerPx || 20,
    h: state.height * state.metersPerPx || 20,
  };
}

function frameCameras() {
  resize();
  const { w, h } = planSize();
  const size = Math.max(w, h);

  // Distance at which the plan fills the view, then viewed from about 50 degrees up.
  const vFov = THREE.MathUtils.degToRad(perspective.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * perspective.aspect);
  const distance = Math.max(h / 2 / Math.tan(vFov / 2), w / 2 / Math.tan(hFov / 2)) * 1.25;
  const elevation = THREE.MathUtils.degToRad(50);
  perspective.position.set(0, distance * Math.sin(elevation), distance * Math.cos(elevation));
  controls3d.target.set(0, 0, 0);
  controls3d.minDistance = size * 0.05;
  controls3d.maxDistance = size * 4;
  controls3d.update();

  ortho.position.set(0, size * 2, 0);
  ortho.zoom = 1;
  controls2d.target.set(0, 0, 0);
  controls2d.update();
}

function resize() {
  const { clientWidth: width, clientHeight: height } = ui.stage;
  if (!width || !height) return;
  renderer.setSize(width, height, false);
  const aspect = width / height;

  perspective.aspect = aspect;
  perspective.updateProjectionMatrix();

  const { w, h } = planSize();
  const margin = 1.08;
  const halfH = Math.max(h / 2, w / 2 / aspect) * margin;
  ortho.top = halfH;
  ortho.bottom = -halfH;
  ortho.left = -halfH * aspect;
  ortho.right = halfH * aspect;
  ortho.updateProjectionMatrix();
}

new ResizeObserver(resize).observe(ui.stage);

// ---------------------------------------------------------------- hover

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pointerDown = false;

renderer.domElement.addEventListener('pointerdown', () => { pointerDown = true; hideTooltip(); });
window.addEventListener('pointerup', () => { pointerDown = false; });
renderer.domElement.addEventListener('pointerleave', hideTooltip);
renderer.domElement.addEventListener('pointermove', (e) => {
  if (pointerDown) return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, activeCamera());

  const pickable = CLASSES.filter((c) => classGroups[c].visible)
    .flatMap((c) => classGroups[c].children.filter((m) => m.visible));
  // In the top view, prefer the opening over the wall it sits in.
  const hits = raycaster.intersectObjects(pickable, false);
  const hit = state.view === '2d'
    ? hits.sort((a, b) => CLASSES.indexOf(b.object.userData.detection.cls) - CLASSES.indexOf(a.object.userData.detection.cls))[0]
    : hits[0];
  if (!hit) return hideTooltip();

  const d = hit.object.userData.detection;
  ui.tooltip.innerHTML = `<strong>${d.cls}</strong> ${(d.score * 100).toFixed(1)}%<br>`
    + `<span>${d.x1},${d.y1} → ${d.x2},${d.y2} px</span>`;
  ui.tooltip.hidden = false;

  const tipW = ui.tooltip.offsetWidth;
  const tipH = ui.tooltip.offsetHeight;
  let x = e.clientX - rect.left + 14;
  let y = e.clientY - rect.top + 14;
  if (x + tipW > rect.width - 8) x = e.clientX - rect.left - tipW - 14;
  if (y + tipH > rect.height - 8) y = e.clientY - rect.top - tipH - 14;
  ui.tooltip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
});

function hideTooltip() {
  ui.tooltip.hidden = true;
}

// ---------------------------------------------------------------- misc

function activeCamera() {
  return state.view === '2d' ? ortho : perspective;
}

function setBusy(busy) {
  state.busy = busy;
  ui.detect.disabled = busy || !state.canvas;
  ui.file.disabled = busy;
}

function setStatus(message, isError = false) {
  ui.status.textContent = message;
  ui.status.classList.toggle('error', isError);
}

function renderMeta(data) {
  const { w, h } = planSize();
  const rows = [
    ['Image', `${state.width} × ${state.height} px`],
    ['Plan size', `${w.toFixed(1)} × ${h.toFixed(1)} m`],
  ];
  if (data) rows.push(['Avg. door', data.averageDoor > 0 ? `${data.averageDoor.toFixed(1)} px` : 'none found']);
  ui.meta.replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = k;
    dd.textContent = v;
    return [dt, dd];
  }));
}

renderer.setAnimationLoop(() => {
  (state.view === '2d' ? controls2d : controls3d).update();
  renderer.render(scene, activeCamera());
});
