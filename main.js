// main.js

import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { XRButton } from 'https://unpkg.com/three@0.160.0/examples/jsm/webxr/XRButton.js';

let renderer, scene, camera, clock, audioCtx;
let targets = new Set();
let score = 0;
let paused = false;
let lastSpawnAt = 0;

// perf + reuse
const _raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _scratch = [];

// constants
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

// shared resources (geometry stays shared; material is cloned per mesh)
let _sharedGeo, _baseMat;

// -------------------------------------------------

init();

function init() {
  // renderer
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance'
  });
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

  // optional: fog looks odd in AR; start disabled, or keep very light if you insist
  scene.fog = null;
  renderer.xr.addEventListener('sessionstart', () => {
    // keep it clean in AR
    scene.fog = null;
    // lazy-init audio on user gesture; XR entry counts as gesture on most browsers
    ensureAudio();
  });

  // input
  renderer.domElement.addEventListener('pointerdown', onTap);

  // controls
  $btnReset.addEventListener('click', resetGame);
  $btnPause.addEventListener('click', () => {
    paused = !paused;
    $btnPause.textContent = paused ? 'resume' : 'pause';
  });
  $btnSpawn.addEventListener('click', () => spawnBurst(performance.now()));

  window.addEventListener('resize', onResize);

  // XR button (request AR). we don't require hit-test for this mini-game.
  document.body.appendChild(XRButton.createButton(renderer, {
    requiredFeatures: ['local'], // stable local reference space
    optionalFeatures: []         // minimal permissions
  }));

  // animation loop
  clock = new THREE.Clock();
  renderer.setAnimationLoop(onXRFrame);

  // expose for console debugging if needed
  window.__app = { THREE, renderer, scene, camera, targets };
}

// -------------------------------------------------

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function onXRFrame(/* time, frame */) {
  const dt = clock.getDelta();        // seconds
  const nowMs = performance.now();    // unified timebase

  if (!paused) {
    maybeSpawnTargets(nowMs);
    updateTargets(dt, nowMs);
  }

  renderer.render(scene, camera);
}

// -------------------------------------------------
// spawning

function maybeSpawnTargets(nowMs) {
  if (targets.size >= MAX_TARGETS) return;
  // a little jitter in spawn interval
  const jitter = SPAWN_INTERVAL_MS * (0.6 + Math.random() * 0.8);
  if (nowMs - lastSpawnAt < jitter) return;

  lastSpawnAt = nowMs;
  const t = makeTarget(nowMs);
  scene.add(t);
  targets.add(t);
  updateHUD();
}

function makeTarget(nowMs) {
  const geo = getSharedSphere();
  const mat = getClonedMaterial(); // per-mesh material (no cross-bleed)

  const m = new THREE.Mesh(geo, mat);
  m.userData.createdAt = nowMs;
  m.userData.phase = Math.random() * Math.PI * 2;
  m.userData.bobAmp = 0.12 + Math.random() * 0.12; // bob amplitude
  m.userData.bobSpeed = 0.8 + Math.random() * 1.2; // Hz-ish
  m.userData.spin = (Math.random() * 0.8 + 0.4) * (Math.random() < 0.5 ? -1 : 1);
  m.userData.type = 'target';

  // place 1–3 meters from the XR camera in a random horizontal direction, at ~chest height
  const r = 1 + Math.random() * 2;
  const angle = Math.random() * Math.PI * 2;

  // get forward basis from XR camera
  const xrCam = renderer.xr.getCamera(camera);
  const origin = new THREE.Vector3().setFromMatrixPosition(xrCam.matrixWorld);

  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(xrCam.quaternion);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(xrCam.quaternion);

  const dir = new THREE.Vector3()
    .copy(right).multiplyScalar(Math.cos(angle))
    .add(fwd.multiplyScalar(Math.sin(angle))).normalize();

  const pos = new THREE.Vector3().copy(origin).addScaledVector(dir, r);
  pos.y += 1.2 + Math.random() * 0.6; // 1.2–1.8m high

  m.position.copy(pos);
  m.userData.baseY = m.position.y; // stable baseline for bobbing
  m.scale.setScalar(1);

  return m;
}

// -------------------------------------------------
// shared resources

function getSharedSphere() {
  if (!_sharedGeo) _sharedGeo = new THREE.SphereGeometry(TARGET_RADIUS, 16, 12);
  return _sharedGeo;
}

function getClonedMaterial() {
  if (!_baseMat) {
    _baseMat = new THREE.MeshStandardMaterial({
      color: 0xff5555,
      emissive: 0x220000,
      roughness: 0.3,
      metalness: 0.0
    });
  }
  // important: clone so each mesh can change opacity/color independently
  return _baseMat.clone();
}

// -------------------------------------------------
// per-frame updates

function updateTargets(dt, nowMs) {
  const toRemove = [];
  for (const m of targets) {
    // absolute bob (no drift)
    const t = (nowMs * 0.001) * m.userData.bobSpeed + m.userData.phase;
    m.position.y = m.userData.baseY + Math.sin(t) * m.userData.bobAmp;

    // gentle spin
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

// -------------------------------------------------
// input

function onTap(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  _ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  _ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  _raycaster.setFromCamera(_ndc, renderer.xr.getCamera(camera));

  _scratch.length = 0;
  for (const t of targets) _scratch.push(t);

  const hits = _raycaster.intersectObjects(_scratch, false);

  if (hits.length) {
    const hit = hits[0].object;
    popTarget(hit);
  }
}

// -------------------------------------------------
// pop animation + feedback

function popTarget(obj) {
  if (!targets.has(obj)) return;
  targets.delete(obj);

  // haptics (no-op if unsupported)
  try { navigator.vibrate?.(15); } catch (_) {}

  // micro audio blip
  try { blip(); } catch (_) {}

  const start = performance.now();
  const dur = 180; // ms
  const startScale = obj.scale.x;
  const startColor = obj.material.color.clone();

  // ensure material can fade independently
  obj.material.transparent = true;

  function tween() {
    const t = Math.min(1, (performance.now() - start) / dur);
    const s = startScale * (1 + 1.2 * t);
    obj.scale.setScalar(s);
    obj.material.color.lerpColors(startColor, new THREE.Color(0xffffff), t);
    obj.material.opacity = 1 - t;

    if (t < 1) {
      requestAnimationFrame(tween);
    } else {
      scene.remove(obj);
      // if you ever pool meshes, reset .opacity=1 and .transparent=false here
    }
  }
  requestAnimationFrame(tween);

  score += 1;
  updateHUD();
}

function ensureAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (_) {
    audioCtx = null;
  }
}

function blip() {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = 600; // start freq

  const now = audioCtx.currentTime;
  osc.frequency.setValueAtTime(600, now);
  osc.frequency.exponentialRampToValueAtTime(1200, now + 0.06);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.2, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);

  osc.connect(gain).connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + 0.1);
}

// -------------------------------------------------
// controls

function resetGame() {
  for (const m of targets) scene.remove(m);
  targets.clear();
  score = 0;
  lastSpawnAt = 0;
  paused = false;
  document.getElementById('pause').textContent = 'pause';
  updateHUD();
}

function spawnBurst(nowMs) {
  const n = Math.min(8, MAX_TARGETS - targets.size);
  for (let i = 0; i < n; i++) {
    const t = makeTarget(nowMs);
    scene.add(t);
    targets.add(t);
  }
  updateHUD();
}

// -------------------------------------------------

function updateHUD() {
  $score.textContent = String(score);
  $alive.textContent = String(targets.size);
}
