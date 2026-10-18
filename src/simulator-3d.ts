import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { studioEnvironment, studioFloor } from './simulator-studio';
import { buildHardware, plate, roundedRect } from './simulator-hardware';
import { chosenFinish, modelSpec, type Finish, type ModelSpec } from './simulator-models';

/* The simulator as a physical device: a lit, rotatable model whose display shows
 * the live frames. Dragging the frame or background orbits it; pressing the
 * display becomes taps, long presses and swipes in points; the side and home
 * buttons press their hardware counterparts. One unit is 100 points. */

export type DeviceShape = { width: number; height: number; homeButton: boolean; family: 'phone' | 'pad'; deviceType: string };
export type ScreenGesture =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'longPress'; x: number; y: number; durationMs: number }
  | { kind: 'swipe'; x: number; y: number; endX: number; endY: number; durationMs: number };
export type DeviceButton = 'home' | 'lock';
export type Device3D = {
  setShape(shape: DeviceShape): void;
  setFrame(image: CanvasImageSource & { width: number; height: number }): void;
  setMessage(text: string): void;
  setDark(dark: boolean): void;
  /** Repaint the body in one of the model's finishes. */
  setFinish(finish: Finish): void;
  resetView(animate?: boolean): void;
  setActive(active: boolean): void;
  dispose(): void;
};
type Options = {
  onGesture(gesture: ScreenGesture): void;
  onButton(button: DeviceButton): void;
  onScroll(dx: number, dy: number, at: { x: number; y: number }): void;
};

const UNIT = 100;
const TAP_SLOP = 8;
const LONG_PRESS = 450;
const FRONT = new THREE.Euler(0, 0, 0);
const INTRO = new THREE.Euler(0.12, -0.55, 0.02);
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Proportions of the hardware around a display of `shape` points. */
function geometryOf(shape: DeviceShape) {
  const width = shape.width / UNIT, height = shape.height / UNIT, pad = shape.family === 'pad';
  const spec = modelSpec(shape.deviceType, shape.family);
  const side = spec.bezel ?? (pad ? 0.26 : shape.homeButton ? 0.22 : 0.17);
  const cap = shape.homeButton ? (pad ? 0.95 : 1.05) : side;
  const display = shape.homeButton ? 0 : spec.corner ?? (pad ? 0.19 : 0.55);
  const bodyWidth = width + side * 2;
  return { width, height, pad, side, cap, display, spec, body: { width: bodyWidth, height: height + cap * 2, radius: shape.homeButton ? (pad ? 0.45 : 0.62) : display + side, depth: Math.max(bodyWidth * spec.depth, 0.18) } };
}

export function mountDevice3D(host: HTMLElement, options: Options): Device3D {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Khronos PBR Neutral keeps product colors true (Cosmic Orange stays orange).
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  const canvas = renderer.domElement;
  canvas.className = 'sim-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  host.append(canvas);

  const scene = new THREE.Scene();
  const environment = studioEnvironment(renderer);
  scene.environment = environment;
  const floor = studioFloor(scene);
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 200);
  const controls = new OrbitControls(camera, canvas);
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.09, enablePan: false, rotateSpeed: 0.75, zoomSpeed: 0.8 });

  // The display: frames are drawn into a canvas so orientation is the same in every webview.
  const pixels = document.createElement('canvas');
  pixels.width = 2; pixels.height = 2;
  const paint = pixels.getContext('2d')!;
  const texture = new THREE.CanvasTexture(pixels);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;

  const device = new THREE.Group();
  scene.add(device);
  // Cover glass: black, glossy, and it reflects the studio across the bezel.
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x020203, metalness: 0, roughness: 0.04, ior: 1.52, envMapIntensity: 0.18 });
  // The same glass over the lit display: only its reflections are added on top of the picture.
  const glare = new THREE.MeshPhysicalMaterial({ color: 0x000000, metalness: 0, roughness: 0.04, envMapIntensity: 1, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending });
  const ink = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const screenMaterial = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
  const touchMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
  let screen: THREE.Mesh | undefined, touch: THREE.Mesh | undefined;
  const buttons = new Map<THREE.Object3D, DeviceButton>();
  let shape: DeviceShape = { width: 402, height: 874, homeButton: false, family: 'phone', deviceType: '' };
  let finish: Finish | undefined, hardware: THREE.Material[] = [];
  let fitDistance = 20;

  function clear(): void {
    device.traverse(node => { if (node instanceof THREE.Mesh) node.geometry.dispose(); });
    hardware.forEach(material => material.dispose()); hardware = [];
    device.clear(); buttons.clear();
  }
  function build(): void {
    clear();
    const g = geometryOf(shape), { body, spec } = g, bevel = Math.min(0.07, body.depth / 4);
    const look = finish && spec.finishes.some(item => item.id === finish!.id) ? finish : chosenFinish(spec);
    finish = look;
    const made = buildHardware(device, spec, look, body, { width: g.width, height: g.height, side: g.side, cap: g.cap }, ink);
    hardware = made.materials;
    const [frame, panel] = made.materials as THREE.MeshPhysicalMaterial[];
    const slab = new THREE.ExtrudeGeometry(roundedRect(body.width - bevel * 2, body.height - bevel * 2, body.radius - bevel), { depth: body.depth - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 8, curveSegments: 40 });
    slab.translate(0, 0, -(body.depth - bevel * 2) / 2);
    device.add(new THREE.Mesh(slab, [panel, frame]));
    const front = body.depth / 2;
    const cover = new THREE.Mesh(plate(body.width - bevel * 1.2, body.height - bevel * 1.2, body.radius - bevel * 0.6), glass);
    cover.position.z = front + 0.002; device.add(cover);
    screen = new THREE.Mesh(plate(g.width, g.height, g.display), screenMaterial);
    screen.position.z = front + 0.004; device.add(screen);
    const sheen = new THREE.Mesh(plate(g.width, g.height, g.display), glare);
    sheen.position.z = 0.0015; sheen.renderOrder = 1; screen.add(sheen);
    touch = new THREE.Mesh(new THREE.CircleGeometry(0.2, 32), touchMaterial);
    touch.position.z = 0.003; touch.renderOrder = 2; screen.add(touch);
    // Android: a punch-hole camera centered near the top of the display.
    if (spec.front === 'punch') {
      const punch = new THREE.Mesh(new THREE.CircleGeometry(0.055, 32), ink);
      punch.position.set(0, g.height / 2 - 0.26, 0.001); screen.add(punch);
    }
    if (spec.front === 'island' && !shape.homeButton) {
      const island = new THREE.Mesh(plate(1.25, 0.37, 0.185), ink);
      island.position.set(0, g.height / 2 - 0.3, 0.001); screen.add(island);
    }
    if (shape.homeButton) {
      const home = new THREE.Mesh(new THREE.CylinderGeometry(g.pad ? 0.3 : 0.34, g.pad ? 0.3 : 0.34, 0.02, 48), glass);
      home.rotation.x = Math.PI / 2; home.position.set(0, -g.height / 2 - g.cap / 2, front + 0.004);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(g.pad ? 0.3 : 0.34, 0.012, 8, 64), frame);
      ring.position.set(0, -g.height / 2 - g.cap / 2, front + 0.012);
      device.add(home, ring); buttons.set(home, 'home');
    }
    made.buttons.forEach((name, mesh) => buttons.set(mesh, name));
    device.traverse(node => { if (node instanceof THREE.Mesh && node.material !== glare && node.material !== touchMaterial) node.castShadow = true; });
    floor.place(-Math.max(body.height, body.width) / 2, Math.max(body.height, body.width));
    fit();
  }

  let fitted = false;
  function fit(): void {
    const { width, height } = host.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    const body = geometryOf(shape).body, half = THREE.MathUtils.degToRad(camera.fov / 2);
    const byHeight = (body.height / 2) / Math.tan(half), byWidth = (body.width / 2) / (Math.tan(half) * camera.aspect);
    const distance = Math.max(byHeight, byWidth) / 0.84;
    // Keep the user's zoom relative to the fitted distance across resizes.
    const zoom = fitted ? THREE.MathUtils.clamp(camera.position.length() / fitDistance, 0.45, 2.6) : 1;
    fitDistance = distance; fitted = true;
    controls.minDistance = distance * 0.45; controls.maxDistance = distance * 2.6;
    if (!camera.position.lengthSq()) camera.position.set(0, 0, 1);
    camera.position.setLength(distance * zoom);
    camera.updateProjectionMatrix(); dirty = true;
  }

  /* Rendering runs only while visible and stops when nothing moves. */
  let frame = 0, dirty = true, active = false, turning: { from: THREE.Quaternion; to: THREE.Quaternion; start: number; duration: number } | undefined;
  let touchFade = 0;
  const tick = (now: number) => {
    frame = 0;
    if (!active) return;
    let moving = controls.update();
    if (turning) {
      const t = Math.min(1, (now - turning.start) / turning.duration), eased = 1 - Math.pow(1 - t, 3);
      device.quaternion.slerpQuaternions(turning.from, turning.to, eased);
      if (t >= 1) turning = undefined;
      moving = true;
    }
    if (touchFade && touchMaterial.opacity > 0) { touchMaterial.opacity = Math.max(0, touchMaterial.opacity - 0.06); moving = true; }
    if (moving || dirty) { renderer.render(scene, camera); dirty = false; }
    frame = requestAnimationFrame(tick);
  };
  const wake = () => { dirty = true; if (active && !frame) frame = requestAnimationFrame(tick); };
  controls.addEventListener('change', wake);

  function turnTo(euler: THREE.Euler, duration: number): void {
    const to = new THREE.Quaternion().setFromEuler(euler);
    if (reduceMotion() || !duration) { device.quaternion.copy(to); turning = undefined; wake(); return; }
    turning = { from: device.quaternion.clone(), to, start: performance.now(), duration }; wake();
  }

  /* Picking: the display maps to points; buttons press hardware; anything else orbits. */
  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
  function ray(event: { clientX: number; clientY: number }): void {
    const rect = canvas.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
  }
  function toPoints(local: THREE.Vector3): { x: number; y: number } {
    const g = geometryOf(shape);
    return { x: THREE.MathUtils.clamp((local.x + g.width / 2) * UNIT, 0, shape.width), y: THREE.MathUtils.clamp((g.height / 2 - local.y) * UNIT, 0, shape.height) };
  }
  function pick(event: { clientX: number; clientY: number }): { kind: 'screen'; point: { x: number; y: number }; local: THREE.Vector3 } | { kind: 'button'; name: DeviceButton; mesh: THREE.Object3D } | undefined {
    if (!screen) return;
    ray(event);
    const hit = raycaster.intersectObjects(device.children, false)[0];
    if (!hit) return;
    if (hit.object === screen) {
      // Only the face that looks at the camera is a touch surface.
      const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(device.quaternion);
      if (normal.dot(raycaster.ray.direction) >= 0) return;
      const local = screen.worldToLocal(hit.point.clone());
      return { kind: 'screen', point: toPoints(local), local };
    }
    const name = buttons.get(hit.object);
    return name ? { kind: 'button', name, mesh: hit.object } : undefined;
  }
  /** Where the pointer meets the display's plane, even past its edge, while a finger is down. */
  function onPlane(event: { clientX: number; clientY: number }): { x: number; y: number; local: THREE.Vector3 } | undefined {
    if (!screen) return;
    ray(event);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1).applyQuaternion(device.quaternion), screen.getWorldPosition(new THREE.Vector3()));
    const point = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (!point) return;
    const local = screen.worldToLocal(point);
    return { ...toPoints(local), local };
  }
  function showTouch(local: THREE.Vector3, opacity: number): void {
    if (!touch) return;
    touch.position.set(local.x, local.y, 0.002);
    touchMaterial.opacity = opacity; touchFade = opacity < 0.3 ? 1 : 0; wake();
  }

  let gesture: { id: number; start: { x: number; y: number }; last: { x: number; y: number }; at: number } | undefined;
  const onDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const hit = pick(event);
    if (!hit) return;
    // Handled here, before OrbitControls on the canvas sees the press.
    event.stopPropagation(); event.preventDefault();
    host.focus({ preventScroll: true });
    if (hit.kind === 'button') {
      const original = hit.mesh.position.clone(), inward = hit.mesh.position.x === 0 ? new THREE.Vector3(0, -0.03, 0) : new THREE.Vector3(Math.sign(hit.mesh.position.x) * -0.03, 0, 0);
      if (hit.name === 'home') inward.set(0, 0, -0.01);
      hit.mesh.position.add(inward); wake();
      window.setTimeout(() => { hit.mesh.position.copy(original); wake(); }, 140);
      options.onButton(hit.name); return;
    }
    canvas.setPointerCapture(event.pointerId);
    gesture = { id: event.pointerId, start: hit.point, last: hit.point, at: performance.now() };
    showTouch(hit.local, 0.42);
  };
  const onMove = (event: PointerEvent) => {
    if (gesture && event.pointerId === gesture.id) {
      const at = onPlane(event); if (!at) return;
      gesture.last = { x: at.x, y: at.y }; showTouch(at.local, 0.42); return;
    }
    if (event.buttons) return;
    const hit = pick(event);
    canvas.style.cursor = hit?.kind === 'screen' ? 'pointer' : hit?.kind === 'button' ? 'pointer' : 'grab';
  };
  const onUp = (event: PointerEvent) => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const { start, last, at } = gesture; gesture = undefined;
    const held = performance.now() - at, moved = Math.hypot(last.x - start.x, last.y - start.y);
    touchFade = 1;
    if (event.type === 'pointercancel') return;
    if (moved < TAP_SLOP) options.onGesture(held >= LONG_PRESS ? { kind: 'longPress', x: start.x, y: start.y, durationMs: Math.round(held) } : { kind: 'tap', x: start.x, y: start.y });
    else options.onGesture({ kind: 'swipe', x: start.x, y: start.y, endX: last.x, endY: last.y, durationMs: Math.round(THREE.MathUtils.clamp(held, 80, 2000)) });
  };
  /* The wheel scrolls the app over the display and zooms elsewhere; pinch always zooms. */
  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey) return;
    const hit = pick(event);
    if (hit?.kind !== 'screen') return;
    event.stopPropagation(); event.preventDefault();
    options.onScroll(event.deltaX, event.deltaY, hit.point);
  };
  const onDouble = (event: MouseEvent) => { if (!pick(event)) { resetView(true); } };
  host.addEventListener('pointerdown', onDown, { capture: true });
  host.addEventListener('wheel', onWheel, { capture: true, passive: false });
  host.addEventListener('dblclick', onDouble);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  const resize = new ResizeObserver(() => fit());
  resize.observe(host);

  /** The display texture stays at 2× points; resizing a live texture's canvas leaves the GPU copy at its old size. */
  function sizeDisplay(): void {
    const width = Math.round(shape.width * 2), height = Math.round(shape.height * 2);
    if (pixels.width === width && pixels.height === height) return;
    pixels.width = width; pixels.height = height;
    texture.dispose();
  }
  function setMessage(text: string): void {
    sizeDisplay();
    paint.fillStyle = '#000'; paint.fillRect(0, 0, pixels.width, pixels.height);
    if (text) {
      paint.fillStyle = 'rgba(255,255,255,.62)'; paint.textAlign = 'center'; paint.textBaseline = 'middle';
      paint.font = `500 ${Math.round(pixels.width / 15)}px -apple-system, BlinkMacSystemFont, sans-serif`;
      paint.fillText(text, pixels.width / 2, pixels.height / 2, pixels.width * 0.86);
    }
    texture.needsUpdate = true; wake();
  }
  function resetView(animate = true): void {
    camera.position.set(0, 0, fitDistance); controls.target.set(0, 0, 0); controls.update();
    turnTo(FRONT, animate ? 520 : 0);
  }

  build();
  device.quaternion.setFromEuler(INTRO);
  setMessage('');

  return {
    setShape(next) {
      if (next.width === shape.width && next.height === shape.height && next.homeButton === shape.homeButton && next.family === shape.family && next.deviceType === shape.deviceType) return;
      shape = next; build(); wake();
    },
    setFrame(image) {
      sizeDisplay();
      // Frames arrive at whatever scale the producer chose; each one fills the display.
      paint.drawImage(image, 0, 0, pixels.width, pixels.height);
      texture.needsUpdate = true; wake();
    },
    setMessage,
    setDark() { wake(); },
    setFinish(next) { finish = next; build(); wake(); },
    resetView,
    setActive(next) {
      if (active === next) return;
      active = next;
      if (active) { fit(); if (device.quaternion.angleTo(new THREE.Quaternion()) > 0.3 && !turning) turnTo(FRONT.clone().set(0.04, -0.18, 0), 900); wake(); }
      else if (frame) { cancelAnimationFrame(frame); frame = 0; }
    },
    dispose() {
      active = false; if (frame) cancelAnimationFrame(frame);
      resize.disconnect(); controls.dispose(); clear();
      host.removeEventListener('pointerdown', onDown, { capture: true });
      host.removeEventListener('wheel', onWheel, { capture: true });
      host.removeEventListener('dblclick', onDouble);
      for (const material of [glass, glare, ink, screenMaterial, touchMaterial]) material.dispose();
      floor.dispose();
      texture.dispose(); environment.dispose(); renderer.dispose(); canvas.remove();
    },
  };
}
