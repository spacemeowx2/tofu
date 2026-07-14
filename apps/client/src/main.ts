import "./style.css";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { ColyseusSDK, type Room } from "@colyseus/sdk";
import {
  ARENA_HALF_SIZE,
  ARENA_OBSTACLES,
  PLAYER_MAX_HP,
  ROOM_NAME,
  type GameEvent,
  type MoveInput,
  type ShootInput
} from "@tofu/protocol";

type PlayerView = {
  id: string;
  name: string;
  x: number;
  z: number;
  facingX: number;
  facingZ: number;
  hp: number;
  alive: boolean;
};
type BulletView = { id: string; ownerId: string; x: number; y: number; z: number };
type StateMap<T> = { forEach(callback: (value: T, key: string) => void): void };
type ArenaView = { players: StateMap<PlayerView>; bullets: StateMap<BulletView>; tick: number };
type PlayerMesh = { root: TransformNode; material: StandardMaterial };

const canvas = document.querySelector<HTMLCanvasElement>("#game")!;
const status = document.querySelector<HTMLDivElement>("#status")!;
const playersHud = document.querySelector<HTMLDivElement>("#players")!;
const feed = document.querySelector<HTMLDivElement>("#feed")!;
const controls = document.querySelector<HTMLDivElement>("#controls")!;
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
const scene = new Scene(engine);
scene.clearColor = new Color4(0.79, 0.89, 0.82, 1);

const camera = new FreeCamera("camera", new Vector3(0, 2.85, -5.5), scene);
camera.minZ = 0.1;
camera.inputs.clear();

const light = new HemisphericLight("sun", new Vector3(-0.3, 1, -0.2), scene);
light.intensity = 1.25;
light.groundColor = new Color3(0.35, 0.45, 0.38);

createArena();
const playerMeshes = new Map<string, PlayerMesh>();
const bulletMeshes = new Map<string, Mesh>();
const keys = new Set<string>();
let room: Room | undefined;
let localSessionId = "";
let inputSequence = 0;
let shootSequence = 0;
let lastAim = new Vector3(0, 0, 1);
let lastState: ArenaView | undefined;
let sendAccumulator = 0;
let dragLookMode = typeof canvas.requestPointerLock !== "function";
let softLookActive = false;
let draggingView = false;
let dragButton = -1;
let dragMoved = false;
let lastMouseX = 0;
let lastMouseY = 0;
let pointerLockAttempt = 0;
let cameraYaw = 0;
let cameraPitch = -0.24;
const CAMERA_SENSITIVITY = 0.0024;
const CAMERA_DISTANCE = 5.5;
const PLAYER_HEAD_HEIGHT = 1.05;

window.addEventListener("keydown", (event) => {
  if (event.code === "Escape" && (softLookActive || draggingView)) {
    softLookActive = false;
    draggingView = false;
    updateControlHint();
  }
  keys.add(event.code);
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(event.code)) event.preventDefault();
  if (event.code === "Space" && !event.repeat) shoot();
});
window.addEventListener("keyup", (event) => keys.delete(event.code));
window.addEventListener("blur", () => {
  keys.clear();
  softLookActive = false;
  draggingView = false;
  updateControlHint();
});
window.addEventListener("mousemove", (event) => {
  const pointerLocked = document.pointerLockElement === canvas;
  if (!pointerLocked && !softLookActive && !draggingView) return;
  const deltaX = pointerLocked ? event.movementX : event.clientX - lastMouseX;
  const deltaY = pointerLocked ? event.movementY : event.clientY - lastMouseY;
  lastMouseX = event.clientX;
  lastMouseY = event.clientY;
  if (!pointerLocked && Math.abs(deltaX) + Math.abs(deltaY) > 1) dragMoved = true;
  cameraYaw += deltaX * CAMERA_SENSITIVITY;
  cameraPitch = Math.max(-0.75, Math.min(0.08, cameraPitch - deltaY * CAMERA_SENSITIVITY));
  updateAimFromCamera();
});
canvas.addEventListener("mousedown", (event) => {
  canvas.focus();
  if (dragLookMode && (event.button === 0 || event.button === 2)) {
    draggingView = true;
    dragButton = event.button;
    dragMoved = false;
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
    updateControlHint();
  }
});
canvas.addEventListener("click", (event) => {
  if (event.button !== 0) return;
  canvas.focus();
  lastMouseX = event.clientX;
  lastMouseY = event.clientY;
  if (dragLookMode) {
    if (!softLookActive) {
      softLookActive = true;
      updateControlHint();
      return;
    }
    if (!dragMoved) shoot();
    dragMoved = false;
    return;
  }
  if (document.pointerLockElement !== canvas) {
    const attempt = ++pointerLockAttempt;
    if (typeof canvas.requestPointerLock === "function") {
      const lockRequest = canvas.requestPointerLock();
      if (lockRequest) void lockRequest.catch((error) => enableDragLookFallback(error));
    }
    window.setTimeout(() => {
      if (attempt === pointerLockAttempt && document.pointerLockElement !== canvas) {
        enableDragLookFallback("timeout");
      }
    }, 300);
    return;
  }
  shoot();
});
window.addEventListener("mouseup", (event) => {
  if (event.button !== dragButton || !draggingView) return;
  draggingView = false;
  dragButton = -1;
  if (event.button === 2) dragMoved = false;
  updateControlHint();
});
canvas.addEventListener("contextmenu", (event) => event.preventDefault());
document.addEventListener("pointerlockchange", () => {
  if (document.pointerLockElement === canvas) {
    dragLookMode = false;
    softLookActive = false;
    draggingView = false;
  }
  updateControlHint();
});
document.addEventListener("pointerlockerror", (event) => enableDragLookFallback(event));

function enableDragLookFallback(reason?: unknown) {
  void reason;
  dragLookMode = true;
  softLookActive = true;
  draggingView = false;
  updateControlHint();
}

function updateControlHint() {
  const pointerLocked = document.pointerLockElement === canvas;
  document.body.classList.toggle("pointer-locked", pointerLocked);
  document.body.classList.toggle("drag-look", dragLookMode);
  document.body.classList.toggle("soft-look", softLookActive);
  document.body.classList.toggle("dragging-view", draggingView);
  document.body.classList.toggle("aim-active", pointerLocked || softLookActive || dragLookMode);
  if (dragLookMode) {
    controls.innerHTML = draggingView
      ? "<b>拖动中</b> 转动视角<br /><b>WASD</b> 相对镜头移动 · 松开鼠标结束拖动"
      : softLookActive
        ? "<b>移动鼠标</b> 转动视角 · <b>左键短按 / 空格</b> 发射<br /><b>WASD</b> 相对镜头移动 · <b>Esc</b> 暂停视角"
        : "<b>点击画面</b> 启用鼠标视角<br /><b>WASD / 方向键</b> 相对镜头移动";
  } else {
    controls.innerHTML = pointerLocked
      ? "<b>WASD / 方向键</b> 相对镜头移动<br /><b>鼠标</b> 转动视角 · <b>左键 / 空格</b> 发射 · <b>Esc</b> 释放鼠标"
      : "<b>点击画面</b> 锁定鼠标并控制视角<br /><b>WASD / 方向键</b> 相对镜头移动";
  }
}

updateControlHint();

engine.runRenderLoop(() => {
  const dt = engine.getDeltaTime() / 1000;
  sendAccumulator += dt;
  if (sendAccumulator >= 0.05) {
    sendAccumulator = 0;
    sendMovement();
  }
  followLocalPlayer();
  scene.render();
});
window.addEventListener("resize", () => engine.resize());

void connect();

async function connect() {
  const endpoint = `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:2567`;
  const client = new ColyseusSDK(endpoint);
  const params = new URLSearchParams(location.search);
  const name = params.get("name") || `豆腐${Math.floor(100 + Math.random() * 900)}`;
  try {
    room = await client.joinOrCreate(ROOM_NAME, { name });
    localSessionId = room.sessionId;
    status.textContent = `在线 · 房间 ${room.roomId.slice(0, 6)} · ${name}`;
    status.classList.add("online");
    addFeed(`连接成功，你是 ${name}`);
    room.onStateChange((state) => syncState(state as ArenaView));
    room.onMessage<GameEvent>("game_event", (event) => addFeed(event.message));
    room.onLeave(() => {
      status.textContent = "连接已断开，请刷新页面";
      status.classList.remove("online");
    });
    room.onError((_code, message) => addFeed(`服务器错误：${message ?? "unknown"}`));
  } catch (error) {
    status.textContent = "无法连接服务器";
    addFeed(error instanceof Error ? error.message : String(error));
  }
}

function syncState(state: ArenaView) {
  lastState = state;
  const livePlayers = new Set<string>();
  state.players.forEach((player, id) => {
    livePlayers.add(id);
    let view = playerMeshes.get(id);
    if (!view) {
      view = createTofu(id, id === localSessionId);
      playerMeshes.set(id, view);
    }
    view.root.position.x = player.x;
    view.root.position.z = player.z;
    view.root.rotation.y = Math.atan2(player.facingX, player.facingZ);
    view.root.scaling.y = player.alive ? 1 : 0.18;
    view.material.alpha = player.alive ? 1 : 0.48;
  });
  for (const [id, view] of playerMeshes) {
    if (!livePlayers.has(id)) {
      view.root.dispose();
      playerMeshes.delete(id);
    }
  }

  const liveBullets = new Set<string>();
  state.bullets.forEach((bullet, id) => {
    liveBullets.add(id);
    let mesh = bulletMeshes.get(id);
    if (!mesh) {
      mesh = createBullet(bullet.ownerId);
      bulletMeshes.set(id, mesh);
    }
    mesh.position.set(bullet.x, bullet.y, bullet.z);
  });
  for (const [id, mesh] of bulletMeshes) {
    if (!liveBullets.has(id)) {
      mesh.dispose();
      bulletMeshes.delete(id);
    }
  }
  renderPlayersHud(state);
}

function sendMovement() {
  if (!room) return;
  const strafe = Number(keys.has("KeyD") || keys.has("ArrowRight")) - Number(keys.has("KeyA") || keys.has("ArrowLeft"));
  const advance = Number(keys.has("KeyW") || keys.has("ArrowUp")) - Number(keys.has("KeyS") || keys.has("ArrowDown"));
  const forward = cameraForward();
  const right = new Vector3(forward.z, 0, -forward.x);
  const movement = forward.scale(advance).add(right.scale(strafe));
  if (movement.lengthSquared() > 1) movement.normalize();
  const message: MoveInput = { x: movement.x, z: movement.z, sequence: ++inputSequence };
  room.send("move", message);
}

function shoot() {
  if (!room) return;
  updateAimFromCamera();
  const message: ShootInput = { dx: lastAim.x, dy: lastAim.y, dz: lastAim.z, sequence: ++shootSequence };
  room.send("shoot", message);
}

function cameraForward() {
  return new Vector3(Math.sin(cameraYaw), 0, Math.cos(cameraYaw));
}

function cameraViewDirection() {
  const horizontalScale = Math.cos(cameraPitch);
  return new Vector3(
    Math.sin(cameraYaw) * horizontalScale,
    Math.sin(cameraPitch),
    Math.cos(cameraYaw) * horizontalScale
  ).normalize();
}

function updateAimFromCamera() {
  lastAim = cameraViewDirection();
}

function followLocalPlayer() {
  const local = findPlayer(localSessionId);
  if (!local) return;
  const headPivot = new Vector3(local.x, PLAYER_HEAD_HEIGHT, local.z);
  camera.position.copyFrom(headPivot.subtract(cameraViewDirection().scale(CAMERA_DISTANCE)));
  camera.setTarget(headPivot);
}

function findPlayer(id: string) {
  let found: PlayerView | undefined;
  lastState?.players.forEach((player, key) => { if (key === id) found = player; });
  return found;
}

function createArena() {
  const floor = MeshBuilder.CreateGround("paintable-floor", { width: 27, height: 27 }, scene);
  const floorMaterial = new StandardMaterial("floor-material", scene);
  floorMaterial.diffuseColor = new Color3(0.73, 0.76, 0.68);
  floor.material = floorMaterial;

  const stripeMaterial = new StandardMaterial("stripe", scene);
  stripeMaterial.diffuseColor = new Color3(0.95, 0.89, 0.57);
  stripeMaterial.alpha = 0.85;
  for (let i = -10; i <= 10; i += 4) {
    const stripe = MeshBuilder.CreateBox(`stripe-${i}`, { width: 0.08, height: 0.015, depth: 24 }, scene);
    stripe.position.set(i, 0.012, 0);
    stripe.material = stripeMaterial;
  }

  const wallMaterial = new StandardMaterial("wall-material", scene);
  wallMaterial.diffuseColor = new Color3(0.12, 0.18, 0.14);
  const size = ARENA_HALF_SIZE * 2 + 1;
  const walls = [
    { x: 0, z: -ARENA_HALF_SIZE - 0.25, width: size, depth: 0.5 },
    { x: 0, z: ARENA_HALF_SIZE + 0.25, width: size, depth: 0.5 },
    { x: -ARENA_HALF_SIZE - 0.25, z: 0, width: 0.5, depth: size },
    { x: ARENA_HALF_SIZE + 0.25, z: 0, width: 0.5, depth: size }
  ];
  walls.forEach((wall, index) => {
    const mesh = MeshBuilder.CreateBox(`wall-${index}`, { width: wall.width, depth: wall.depth, height: 0.45 }, scene);
    mesh.position.set(wall.x, 0.225, wall.z);
    mesh.material = wallMaterial;
  });

  ARENA_OBSTACLES.forEach((box, index) => {
    const mesh = MeshBuilder.CreateBox(`cover-${index}`, { width: box.width, depth: box.depth, height: box.height }, scene);
    mesh.position.set(box.x, box.height / 2, box.z);
    mesh.material = index % 2 === 0 ? makeMaterial(`cover-a-${index}`, new Color3(0.88, 0.38, 0.27)) : makeMaterial(`cover-b-${index}`, new Color3(0.24, 0.52, 0.42));
  });
  return floor;
}

function createTofu(id: string, local: boolean): PlayerMesh {
  const root = new TransformNode(`tofu-${id}`, scene);
  const body = MeshBuilder.CreateBox(`body-${id}`, { width: 1.25, height: 1.35, depth: 1.25 }, scene);
  body.parent = root;
  body.position.y = 0.7;
  const material = new StandardMaterial(`tofu-material-${id}`, scene);
  material.diffuseColor = local ? new Color3(1, 0.86, 0.48) : colorFromId(id);
  material.specularColor = new Color3(0.12, 0.12, 0.1);
  body.material = material;

  const eyeMaterial = new StandardMaterial(`eyes-${id}`, scene);
  eyeMaterial.diffuseColor = new Color3(0.08, 0.1, 0.08);
  for (const x of [-0.25, 0.25]) {
    const eye = MeshBuilder.CreateSphere(`eye-${id}-${x}`, { diameter: 0.12, segments: 8 }, scene);
    eye.parent = root;
    eye.position.set(x, 0.82, 0.63);
    eye.material = eyeMaterial;
  }
  const band = MeshBuilder.CreateBox(`band-${id}`, { width: 1.33, height: 0.15, depth: 1.33 }, scene);
  band.parent = root;
  band.position.y = 1.13;
  band.material = makeMaterial(`band-material-${id}`, local ? new Color3(0.9, 0.2, 0.15) : new Color3(0.1, 0.26, 0.18));
  return { root, material };
}

function createBullet(ownerId: string) {
  const bullet = MeshBuilder.CreateSphere("soy-bullet", { diameter: 0.38, segments: 10 }, scene);
  const material = new StandardMaterial(`bullet-material-${ownerId}`, scene);
  material.diffuseColor = colorFromId(ownerId);
  material.emissiveColor = material.diffuseColor.scale(0.55);
  bullet.material = material;
  return bullet;
}

function makeMaterial(name: string, color: Color3) {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = color;
  material.specularColor = new Color3(0.08, 0.08, 0.07);
  return material;
}

function colorFromId(id: string) {
  const palette = [new Color3(0.96, 0.48, 0.36), new Color3(0.33, 0.65, 0.52), new Color3(0.42, 0.55, 0.9), new Color3(0.75, 0.42, 0.82)];
  const hash = [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return palette[hash % palette.length];
}

function renderPlayersHud(state: ArenaView) {
  const cards: string[] = [];
  state.players.forEach((player, id) => {
    const color = player.hp > 50 ? "#43ad61" : player.hp > 0 ? "#e5a83c" : "#bd4034";
    cards.push(`<div class="player-card"><div class="player-line"><strong>${escapeHtml(player.name)}${id === localSessionId ? " · 你" : ""}</strong><span>${player.hp}/${PLAYER_MAX_HP}</span></div><div class="hp-track"><div class="hp-fill" style="width:${player.hp}%;background:${color}"></div></div></div>`);
  });
  playersHud.innerHTML = cards.join("");
}

function addFeed(message: string) {
  const item = document.createElement("div");
  item.className = "feed-item";
  item.textContent = message;
  feed.prepend(item);
  while (feed.children.length > 4) feed.lastElementChild?.remove();
  window.setTimeout(() => item.remove(), 4500);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}
