import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { XRButton } from 'https://unpkg.com/three@0.160.0/examples/jsm/webxr/XRButton.js';

let renderer, scene, camera, clock;
let targets = new Set();
let score = 0;
let paused = false;
let lastSpawnAt = 0;

const MAX_TARGETS = 14;
const SPAWN_INTERVAL_MS = 1000;   // avg spawn rate
const TARGET_RADIUS = 0.08;       // ~8cm
const TARGET_LIFETIME = 12000;    // ms before auto-despawn

// UI refs
const $score = document.getElementById('score');
const $alive = document.getElementById('alive');
const $btnReset = document.getElementById('reset');
const $btnPause = document.getElementById('pause');
const $btnSpawn = document.getElementById('spawn');

init();
function init() {
  // renderer
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  document.body.appendChild(renderer.domElement);

  // scene + camera
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 30);

  // light
  const hemi = new THREE.HemisphereLight(0xffffff, 0x333366, 1.0);
  scene.add(hemi);

  // subtle fog to reduce aliasing shimmer
  scene.fog = new THREE.FogExp2(0x000000, 0.18);

  // listen to touch taps on the canvas
  renderer.domElement.addEventListener('pointerdown', onTap);

  // controls
  $btnReset.addEventListener('click', resetGame);
  $btnPause.addEventListener('click', () => { paused = !paused; $btnPause.textContent = paused ? 'resume' : 'pause'; });
  $btnSpawn.addEventListener('click', spawnBurst);

  window.addEventListener('resize', onResize);

  // XR button (request AR). we don't require hit-test for this mini-game.
  document.body.appendChild(XRButton.createButton(renderer, {
    requiredFeatures: ['local'], // stable local reference space
    optionalFeatures: []         // keep minimal; faster permission UX
  }));

  // animation loop
  clock = new THREE.Clock();
  renderer.setAnimationLoop(onXRFrame);

  // expose for console debugging if needed
  window.__app = { THREE, renderer, scene, camera, targets };
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function onXRFrame(time, frame) {
  const dt = clock.getDelta(); // seconds

  if (!paused) {
    maybeSpawnTargets(time);
    updateTargets(dt, time);
  }

  // draw
  renderer.render(scene, camera);
}

function maybeSpawnTargets(nowMs) {
  if (targets.size >= MAX_TARGETS) return;
  if (nowMs - lastSpawnAt < SPAWN_INTERVAL_MS * (0.6 + Math.random()*0.8)) return;
  lastSpawnAt = nowMs;
  const t = makeTarget();
  scene.add(t);
  targets.add(t);
  updateHUD();
}

function makeTarget() {
  // geometry/material are shared for perf
  const geo = getSharedSphere();
  const mat = getSharedMaterial();

  const m = new THREE.Mesh(geo, mat);
  m.userData.createdAt = performance.now();
  m.userData.phase = Math.random() * Math.PI * 2;
  m.userData.bobAmp = 0.12 + Math.random() * 0.12; // bob amplitude
  m.userData.bobSpeed = 0.8 + Math.random() * 1.2; // Hz-ish
  m.userData.spin = (Math.random() * 0.8 + 0.4) * (Math.random() < 0.5 ? -1 : 1);
  m.userData.type = 'target';

  // place 1–3 meters from the **XR camera** in a random horizontal direction, at ~chest height
  const r = 1 + Math.random() * 2;
  const angle = Math.random() * Math.PI * 2;

  // get forward basis from XR camera
  // renderer.xr.getCamera(camera) returns a "XRManagedCamera" with world transforms
  const xrCam = renderer.xr.getCamera(camera);
  const origin = new THREE.Vector3().setFromMatrixPosition(xrCam.matrixWorld);

  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(xrCam.quaternion);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(xrCam.quaternion);

  const dir = new THREE.Vector3().copy(right).multiplyScalar(Math.cos(angle)).add(fwd.multiplyScalar(Math.sin(angle))).normalize();
  const pos = new THREE.Vector3().copy(origin).addScaledVector(dir, r);
  pos.y += 1.2 + Math.random() * 0.6; // 1.2–1.8m high

  m.position.copy(pos);
  m.scale.setScalar(1);
  return m;
}

let _sharedGeo, _sharedMat;
function getSharedSphere() {
  if (!_sharedGeo) _sharedGeo = new THREE.SphereGeometry(TARGET_RADIUS, 16, 12);
  return _sharedGeo;
}
function getSharedMaterial() {
  if (!_sharedMat) {
    _sharedMat = new THREE.MeshStandardMaterial({
      color: 0xff5555,
      emissive: 0x220000,
      roughness: 0.3,
      metalness: 0.0
    });
  }
  return _sharedMat;
}

function updateTargets(dt, nowMs) {
  const toRemove = [];
  for (const m of targets) {
    // gentle bob
    const t = (nowMs * 0.001) * m.userData.bobSpeed + m.userData.phase;
    const baseY = m.position.y;
    m.position.y = baseY + Math.sin(t) * m.userData.bobAmp * dt; // tiny additive changes per frame
    m.rotation.y += m.userData.spin * dt * 0.5;

    // lifetime auto-despawn
    if (nowMs - m.userData.createdAt > TARGET_LIFETIME) toRemove.push(m);
  }
  for (const m of toRemove) {
    scene.remove(m);
    targets.delete(m);
  }
  if (toRemove.length) updateHUD();
}

function onTap(e) {
  // convert screen tap to a 3D ray and intersect with targets
  const rect = renderer.domElement.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(x, y), renderer.xr.getCamera(camera));

  // build an array of target meshes (kept small)
  const arr = Array.from(targets);
  const hits = raycaster.intersectObjects(arr, false);

  if (hits.length) {
    const hit = hits[0].object;
    popTarget(hit);
  }
}

function popTarget(obj) {
  // quick pop animation (scale up, fade out), then remove
  if (!targets.has(obj)) return;
  targets.delete(obj);

  const start = performance.now();
  const dur = 180; // ms
  const startScale = obj.scale.x;
  const startColor = obj.material.color.clone();

  function tween() {
    const t = Math.min(1, (performance.now() - start) / dur);
    const s = startScale * (1 + 1.2 * t);
    obj.scale.setScalar(s);
    obj.material.color.lerpColors(startColor, new THREE.Color(0xffffff), t);
    obj.material.opacity = 1 - t;
    obj.material.transparent = true;

    if (t < 1) {
      requestAnimationFrame(tween);
    } else {
      scene.remove(obj);
    }
  }
  tween();

  score += 1;
  updateHUD();
}

function resetGame() {
  for (const m of targets) scene.remove(m);
  targets.clear();
  score = 0;
  lastSpawnAt = 0;
  paused = false;
  document.getElementById('pause').textContent = 'pause';
  updateHUD();
}

function spawnBurst() {
  const n = Math.min(8, MAX_TARGETS - targets.size);
  for (let i = 0; i < n; i++) {
    const t = makeTarget();
    scene.add(t);
    targets.add(t);
  }
  updateHUD();
}

function updateHUD() {
  $score.textContent = String(score);
  $alive.textContent = String(targets.size);
}
