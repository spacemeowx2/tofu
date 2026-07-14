import "./style.css";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import {
  ARENA_HALF_SIZE,
  ARENA_OBSTACLES,
  BULLET_DAMAGE,
  BULLET_SPEED,
  PLAYER_MAX_HP,
  PROTOCOL_VERSION,
  SHOT_COOLDOWN_MS,
  type BulletSnapshot,
  type PeerPacket,
  type PaintStamp,
  type PlayerSnapshot,
  type TeamId
} from "@tofu/protocol";
import {
  bulletHitsPlayer,
  ARENA_WALL_HEIGHT,
  createPlayer,
  findWallContact,
  groundPointToCanvasUv,
  InkField,
  respawnPlayer,
  spawnBullet,
  stepBullet,
  stepPlayer,
  wallPointToCanvasUv,
  WALL_SURFACES
} from "@tofu/simulation";
import { ColyseusRelayTransport, type GameTransport, type PeerInfo } from "./transport";

type PlayerMesh = {
  root: TransformNode;
  material: StandardMaterial;
  targetPosition: Vector3;
  velocity: Vector3;
  targetYaw: number;
  diving: boolean;
};

type BulletMesh = {
  mesh: Mesh;
  targetPosition: Vector3;
  velocity: Vector3;
};

type WithoutPacketHeader<T> = T extends unknown
  ? Omit<T, "protocolVersion" | "peerId" | "sequence" | "simulationTick">
  : never;
type OutgoingPeerPacket = WithoutPacketHeader<PeerPacket>;

const TEAM_COLORS = [new Color3(0.96, 0.36, 0.12), new Color3(0.08, 0.64, 0.68)] as const;
const TEAM_COLOR_CSS = ["#f45c1f", "#14a3ad"] as const;
const NEUTRAL_GROUND_COLOR = "#b9c2ad";
const NEUTRAL_COVER_COLOR = "#84917f";
const NEUTRAL_ARENA_WALL_COLOR = "#1f2e24";
const INK_TEXTURE_SIZE = 512;
const PAINT_RADIUS = 1.25;
const SIMULATION_STEP = 1 / 60;
const STATE_SEND_INTERVAL = 1 / 20;
const RESPAWN_SECONDS = 2.5;
const CAMERA_SENSITIVITY = 0.0024;
const CAMERA_DISTANCE = 6.8;
const PLAYER_HEAD_HEIGHT = 1;
const CAMERA_VERTICAL_OFFSET = 0.58;
const AIM_DISTANCE = 45;
const MUZZLE_FORWARD_OFFSET = 0.72;
const MUZZLE_SIDE_OFFSET = 0.34;
const MUZZLE_HEIGHT = 0.82;
const PLAYER_RENDER_SHARPNESS = 18;
const PLAYER_ROTATION_SHARPNESS = 20;
const NETWORK_EXTRAPOLATION_SECONDS = 0.05;
const BULLET_RENDER_SHARPNESS = 30;
const PEER_ID_STORAGE_KEY = "tofu.peerId";
const PLAYER_STATE_STORAGE_KEY = "tofu.playerState";
const PAINT_HISTORY_STORAGE_KEY = "tofu.paintHistory";

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
camera.fov = 0.9;
camera.inputs.clear();

const light = new HemisphericLight("sun", new Vector3(-0.3, 1, -0.2), scene);
light.intensity = 1.25;
light.groundColor = new Color3(0.35, 0.45, 0.38);

const endpoint = `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:2567`;
const transport: GameTransport = new ColyseusRelayTransport(endpoint);
const players = new Map<string, PlayerSnapshot>();
const bullets = new Map<string, BulletSnapshot>();
const playerMeshes = new Map<string, PlayerMesh>();
const bulletMeshes = new Map<string, BulletMesh>();
const roster = new Map<string, PeerInfo>();
const lastStateSequence = new Map<string, number>();
const processedHits = new Set<string>();
const paintHistory = new Map<string, PaintStamp>();
const keys = new Set<string>();
const inkField = new InkField();
const wallInkTextures = new Map<string, DynamicTexture>();
let inkTexture: DynamicTexture;

createArena();

let localSessionId = "";
let currentRoomId = "";
let localPlayer: PlayerSnapshot | undefined;
let packetSequence = 0;
let simulationTick = 0;
let bulletSequence = 0;
let simulationAccumulator = 0;
let stateSendAccumulator = 0;
let respawnRemaining = 0;
let jumpQueued = false;
let mouseFiring = false;
let fireAccumulator = 0;
let lastAim = new Vector3(0, 0, 1);
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
let rosterSignature = "";

window.addEventListener("keydown", (event) => {
  if (event.code === "Escape" && (softLookActive || draggingView)) {
    softLookActive = false;
    draggingView = false;
    setMouseFiring(false);
    updateControlHint();
  }
  keys.add(event.code);
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(event.code)) event.preventDefault();
  if (event.code === "Space" && !event.repeat) jumpQueued = true;
});

window.addEventListener("keyup", (event) => keys.delete(event.code));
window.addEventListener("blur", () => {
  keys.clear();
  softLookActive = false;
  draggingView = false;
  setMouseFiring(false);
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
  if (event.button === 0 && (document.pointerLockElement === canvas || (dragLookMode && softLookActive))) {
    setMouseFiring(true);
    return;
  }
  if (dragLookMode && event.button === 2) {
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
    }
    return;
  }
  if (document.pointerLockElement === canvas) return;
  const attempt = ++pointerLockAttempt;
  const lockRequest = canvas.requestPointerLock?.();
  if (lockRequest) void lockRequest.catch((error) => enableDragLookFallback(error));
  window.setTimeout(() => {
    if (attempt === pointerLockAttempt && document.pointerLockElement !== canvas) enableDragLookFallback("timeout");
  }, 300);
});

window.addEventListener("mouseup", (event) => {
  if (event.button === 0) setMouseFiring(false);
  if (event.button !== dragButton || !draggingView) return;
  draggingView = false;
  dragButton = -1;
  dragMoved = false;
  updateControlHint();
});

canvas.addEventListener("contextmenu", (event) => event.preventDefault());
document.addEventListener("pointerlockchange", () => {
  if (document.pointerLockElement === canvas) {
    dragLookMode = false;
    softLookActive = false;
    draggingView = false;
  } else {
    setMouseFiring(false);
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
    controls.innerHTML = softLookActive
      ? "<b>移动鼠标</b> 转动视角 · <b>按住左键</b> 连射<br /><b>空格</b> 跳跃 · <b>Shift</b> 潜水 · <b>右键拖动</b> 备用视角"
      : "<b>点击画面</b> 启用鼠标视角<br /><b>WASD / 方向键</b> 相对镜头移动";
  } else {
    controls.innerHTML = pointerLocked
      ? "<b>WASD</b> 移动 · <b>按住左键</b> 连射<br /><b>空格</b> 跳跃 · <b>Shift</b> 潜水 · <b>Esc</b> 释放鼠标"
      : "<b>点击画面</b> 锁定鼠标并控制视角<br /><b>WASD / 方向键</b> 相对镜头移动";
  }
}

updateControlHint();

engine.runRenderLoop(() => {
  const dt = Math.min(engine.getDeltaTime() / 1000, 0.1);
  simulationAccumulator += dt;
  while (simulationAccumulator >= SIMULATION_STEP) {
    simulationAccumulator -= SIMULATION_STEP;
    stepLocalSimulation(SIMULATION_STEP);
  }
  updateContinuousFire(dt);
  stateSendAccumulator += dt;
  if (stateSendAccumulator >= STATE_SEND_INTERVAL) {
    stateSendAccumulator %= STATE_SEND_INTERVAL;
    broadcastLocalState();
  }
  updateRenderedPlayers(dt);
  updateRenderedBullets(dt);
  followLocalPlayer();
  scene.render();
});

window.addEventListener("resize", () => engine.resize());
window.addEventListener("beforeunload", () => void transport.close());

void connect();

async function connect() {
  const params = new URLSearchParams(location.search);
  const name = params.get("name") || `豆腐${Math.floor(100 + Math.random() * 900)}`;
  const stablePeerId = getOrCreatePeerId();
  transport.onPacket(handlePeerPacket);
  transport.onPeersChanged(syncRoster);
  try {
    const session = await transport.connect(name, stablePeerId);
    localSessionId = session.peerId;
    currentRoomId = session.roomId;
    restorePaintHistory(currentRoomId);
    syncRoster([...roster.values()]);
    const teamPeers = [...roster.values()].filter((peer) => peer.team === session.team).sort((a, b) => a.id.localeCompare(b.id));
    const teamSlot = Math.max(0, teamPeers.findIndex((peer) => peer.id === localSessionId));
    const player = restoreLocalPlayer(localSessionId, name, session.team, currentRoomId) ?? createPlayer(localSessionId, name, session.team, teamSlot);
    localPlayer = player;
    players.set(localSessionId, player);
    syncPlayerMesh(player, true);
    status.textContent = `转发模式 · 房间 ${session.roomId.slice(0, 6)} · ${name}`;
    status.classList.add("online");
    addFeed(`已加入 ${session.team === 0 ? "橙队" : "青队"}；模拟由你的客户端拥有`);
    broadcastLocalState();
  } catch (error) {
    status.textContent = "无法连接转发节点";
    addFeed(error instanceof Error ? error.message : String(error));
  }
}

function syncRoster(nextPeers: PeerInfo[]) {
  const nextSignature = nextPeers.map((peer) => peer.id).sort().join("|");
  const rosterChanged = nextSignature !== rosterSignature;
  rosterSignature = nextSignature;
  roster.clear();
  nextPeers.forEach((peer) => roster.set(peer.id, peer));
  for (const id of players.keys()) {
    if (id !== localSessionId && !roster.has(id)) removePlayer(id);
  }
  renderPlayersHud();
  if (localPlayer) {
    broadcastLocalState();
    if (rosterChanged) replayPaintHistory();
  }
}

function handlePeerPacket(packet: PeerPacket) {
  if (packet.protocolVersion !== PROTOCOL_VERSION || packet.peerId === localSessionId) return;
  if (packet.kind === "player_state") {
    if (packet.player.id !== packet.peerId || packet.sequence <= (lastStateSequence.get(packet.peerId) ?? -1)) return;
    lastStateSequence.set(packet.peerId, packet.sequence);
    const snapshot = { ...packet.player };
    players.set(packet.peerId, snapshot);
    syncPlayerMesh(snapshot, false);
    renderPlayersHud();
    return;
  }
  if (packet.kind === "shot") {
    if (packet.bullet.ownerId !== packet.peerId || bullets.has(packet.bullet.id)) return;
    bullets.set(packet.bullet.id, { ...packet.bullet });
    syncBulletMesh(packet.bullet);
    return;
  }
  if (packet.kind === "bullet_removed") {
    removeBullet(packet.bulletId);
    return;
  }
  if (packet.kind === "paint") {
    if (roster.get(packet.peerId)?.team !== packet.stamp.team) return;
    applyPaintStamp(packet.stamp);
    return;
  }
  if (packet.kind === "hit" && packet.targetId === localSessionId && localPlayer) {
    const hitKey = `${packet.peerId}:${packet.bulletId}`;
    if (processedHits.has(hitKey) || packet.damage !== BULLET_DAMAGE || !localPlayer.alive) return;
    processedHits.add(hitKey);
    localPlayer.hp = Math.max(0, localPlayer.hp - packet.damage);
    removeBullet(packet.bulletId);
    addFeed(`${players.get(packet.peerId)?.name ?? "对手"} 命中你，造成 ${packet.damage} 点伤害`);
    if (localPlayer.hp === 0) {
      localPlayer.alive = false;
      localPlayer.vx = 0;
      localPlayer.vy = 0;
      localPlayer.vz = 0;
      respawnRemaining = RESPAWN_SECONDS;
    }
    syncPlayerMesh(localPlayer, true);
    broadcastLocalState();
    renderPlayersHud();
  }
}

function stepLocalSimulation(dt: number) {
  if (!localPlayer) return;
  if (!localPlayer.alive) {
    respawnRemaining -= dt;
    if (respawnRemaining <= 0) {
      respawnPlayer(localPlayer);
      addFeed("你已重新凝固");
      broadcastLocalState();
    }
  } else {
    const movement = movementInput();
    const wallContact = findWallContact(localPlayer);
    const wallTeam = wallContact
      ? inkField.teamAtWall(wallContact.id, wallContact.x, wallContact.y, wallContact.z)
      : null;
    stepPlayer(localPlayer, {
      moveX: movement.x,
      moveZ: movement.z,
      jumpPressed: jumpQueued,
      diving: keys.has("ShiftLeft") || keys.has("ShiftRight"),
      groundTeam: inkField.teamAt(localPlayer.x, localPlayer.z),
      wallContact: wallContact ? { ...wallContact, team: wallTeam } : undefined
    }, dt);
    jumpQueued = false;
    syncPlayerMesh(localPlayer, true);
  }

  for (const bullet of [...bullets.values()]) {
    const result = stepBullet(bullet, dt);
    if (!result.alive) {
      if (bullet.ownerId === localSessionId) {
        if (result.paintImpact) {
          const stamp: PaintStamp = {
            id: `paint:${bullet.id}`,
            team: bullet.team,
            surfaceId: result.paintImpact.surfaceId,
            x: result.paintImpact.x,
            y: result.paintImpact.y,
            z: result.paintImpact.z,
            radius: PAINT_RADIUS
          };
          applyPaintStamp(stamp);
          sendPacket({ kind: "paint", stamp });
        }
        sendPacket({ kind: "bullet_removed", bulletId: bullet.id });
      }
      removeBullet(bullet.id);
      continue;
    }
    syncBulletMesh(bullet);
    if (bullet.ownerId !== localSessionId) continue;
    const target = [...players.values()].find(
      (player) => player.id !== localSessionId && player.team !== bullet.team && player.alive && bulletHitsPlayer(bullet, player)
    );
    if (!target) continue;
    sendPacket({ kind: "hit", bulletId: bullet.id, targetId: target.id, damage: BULLET_DAMAGE });
    sendPacket({ kind: "bullet_removed", bulletId: bullet.id });
    addFeed(`你命中 ${target.name}，造成 ${BULLET_DAMAGE} 点伤害`);
    removeBullet(bullet.id);
  }
  simulationTick += 1;
}

function movementInput() {
  const strafe = Number(keys.has("KeyD") || keys.has("ArrowRight")) - Number(keys.has("KeyA") || keys.has("ArrowLeft"));
  const advance = Number(keys.has("KeyW") || keys.has("ArrowUp")) - Number(keys.has("KeyS") || keys.has("ArrowDown"));
  const movement = cameraForward().scale(advance).add(cameraRight().scale(strafe));
  if (movement.lengthSquared() > 1) movement.normalize();
  return { x: movement.x, z: movement.z };
}

function setMouseFiring(active: boolean) {
  if (mouseFiring === active) return;
  mouseFiring = active;
  fireAccumulator = 0;
  if (active) shoot();
}

function updateContinuousFire(dt: number) {
  if (!mouseFiring) return;
  fireAccumulator += dt;
  const interval = SHOT_COOLDOWN_MS / 1000;
  while (fireAccumulator >= interval) {
    fireAccumulator -= interval;
    shoot();
  }
}

function shoot() {
  if (!localPlayer?.alive || localPlayer.diving) return;
  updateAimFromCamera();
  const forward = cameraForward();
  const right = cameraRight();
  const bullet = spawnBullet(
    `${localSessionId}:${++bulletSequence}`,
    localPlayer,
    { x: lastAim.x, y: lastAim.y, z: lastAim.z },
    { x: forward.x, z: forward.z },
    { x: right.x, z: right.z }
  );
  bullets.set(bullet.id, bullet);
  syncBulletMesh(bullet);
  sendPacket({ kind: "shot", bullet });
}

function broadcastLocalState() {
  if (!localPlayer) return;
  sessionStorage.setItem(PLAYER_STATE_STORAGE_KEY, JSON.stringify({ roomId: currentRoomId, player: localPlayer }));
  sendPacket({ kind: "player_state", player: { ...localPlayer } });
}

function getOrCreatePeerId() {
  const existing = sessionStorage.getItem(PEER_ID_STORAGE_KEY);
  if (existing) return existing;
  const generated = globalThis.crypto?.randomUUID?.() ?? `peer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  sessionStorage.setItem(PEER_ID_STORAGE_KEY, generated);
  return generated;
}

function restoreLocalPlayer(peerId: string, name: string, team: TeamId, roomId: string) {
  try {
    const raw = sessionStorage.getItem(PLAYER_STATE_STORAGE_KEY);
    if (!raw) return undefined;
    const stored = JSON.parse(raw) as { roomId: string; player: PlayerSnapshot };
    if (stored.roomId !== roomId) return undefined;
    const player = stored.player;
    if (player.id !== peerId || player.team !== team) return undefined;
    player.name = name;
    player.wallAttached = Boolean(player.wallAttached);
    player.wallSurfaceId = player.wallSurfaceId || "";
    return player;
  } catch {
    return undefined;
  }
}

function restorePaintHistory(roomId: string) {
  try {
    const raw = sessionStorage.getItem(PAINT_HISTORY_STORAGE_KEY);
    if (!raw) return;
    const stored = JSON.parse(raw) as { roomId: string; stamps: PaintStamp[] };
    if (stored.roomId !== roomId) return;
    stored.stamps.forEach(applyPaintStamp);
  } catch {
    sessionStorage.removeItem(PAINT_HISTORY_STORAGE_KEY);
  }
}

function replayPaintHistory() {
  paintHistory.forEach((stamp) => sendPacket({ kind: "paint", stamp }));
}

function sendPacket(payload: OutgoingPeerPacket) {
  if (!localSessionId) return;
  transport.send({
    ...payload,
    protocolVersion: PROTOCOL_VERSION,
    peerId: localSessionId,
    sequence: ++packetSequence,
    simulationTick
  } as PeerPacket);
}

function cameraForward() {
  return new Vector3(Math.sin(cameraYaw), 0, Math.cos(cameraYaw));
}

function cameraRight() {
  const forward = cameraForward();
  return new Vector3(forward.z, 0, -forward.x);
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
  const viewDirection = cameraViewDirection();
  const localView = playerMeshes.get(localSessionId);
  if (!localView) {
    lastAim = viewDirection;
    return;
  }
  const muzzlePosition = localView.root.position
    .add(cameraForward().scale(MUZZLE_FORWARD_OFFSET))
    .add(cameraRight().scale(MUZZLE_SIDE_OFFSET))
    .add(new Vector3(0, MUZZLE_HEIGHT, 0));
  const aimPoint = camera.position.add(viewDirection.scale(AIM_DISTANCE));
  lastAim = aimPoint.subtract(muzzlePosition).normalize();
}

function syncPlayerMesh(player: PlayerSnapshot, local: boolean) {
  let view = playerMeshes.get(player.id);
  if (!view) {
    view = createTofu(player.id, player.team);
    view.root.position.set(player.x, player.y, player.z);
    playerMeshes.set(player.id, view);
  }
  const nextPosition = new Vector3(player.x, player.y, player.z);
  if (Vector3.DistanceSquared(view.targetPosition, nextPosition) > 16) view.root.position.copyFrom(nextPosition);
  view.targetPosition.copyFrom(nextPosition);
  view.velocity.set(player.vx, player.vy, player.vz);
  view.targetYaw = Math.atan2(player.facingX, player.facingZ);
  view.diving = player.diving;
  view.root.scaling.copyFrom(player.alive ? (player.diving ? new Vector3(0.78, 0.32, 1.08) : Vector3.One()) : new Vector3(1, 0.18, 1));
  view.material.alpha = player.alive ? (local ? 1 : 0.92) : 0.48;
}

function syncBulletMesh(bullet: BulletSnapshot) {
  let view = bulletMeshes.get(bullet.id);
  if (!view) {
    view = createBullet(bullet.id, bullet.team);
    view.mesh.position.set(bullet.x, bullet.y, bullet.z);
    bulletMeshes.set(bullet.id, view);
  }
  view.targetPosition.set(bullet.x, bullet.y, bullet.z);
  view.velocity.set(bullet.dx * BULLET_SPEED, bullet.dy * BULLET_SPEED, bullet.dz * BULLET_SPEED);
}

function updateRenderedPlayers(dt: number) {
  const positionBlend = 1 - Math.exp(-PLAYER_RENDER_SHARPNESS * dt);
  const rotationBlend = 1 - Math.exp(-PLAYER_ROTATION_SHARPNESS * dt);
  playerMeshes.forEach((view, id) => {
    const predicted = view.targetPosition.add(view.velocity.scale(id === localSessionId ? 0 : NETWORK_EXTRAPOLATION_SECONDS));
    if (id === localSessionId) view.root.position.copyFrom(predicted);
    else view.root.position.copyFrom(Vector3.Lerp(view.root.position, predicted, positionBlend));
    view.root.rotation.y = lerpAngle(view.root.rotation.y, view.targetYaw, rotationBlend);
  });
}

function updateRenderedBullets(dt: number) {
  const blend = 1 - Math.exp(-BULLET_RENDER_SHARPNESS * dt);
  bulletMeshes.forEach((view) => {
    view.mesh.position.copyFrom(Vector3.Lerp(view.mesh.position, view.targetPosition, blend));
  });
}

function followLocalPlayer() {
  const localView = playerMeshes.get(localSessionId);
  if (!localView) return;
  const headHeight = localView.diving ? 0.34 : PLAYER_HEAD_HEIGHT;
  const headPivot = localView.root.position.add(new Vector3(0, headHeight, 0));
  const viewDirection = cameraViewDirection();
  const cameraPivot = headPivot.add(new Vector3(0, CAMERA_VERTICAL_OFFSET, 0));
  camera.position.copyFrom(cameraPivot.subtract(viewDirection.scale(CAMERA_DISTANCE)));
  camera.setTarget(cameraPivot);
}

function lerpAngle(current: number, target: number, amount: number) {
  const difference = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + difference * amount;
}

function createArena() {
  const floor = MeshBuilder.CreateGround("paintable-floor", { width: 27, height: 27 }, scene);
  const floorMaterial = new StandardMaterial("paintable-floor-material", scene);
  inkTexture = new DynamicTexture("ink-ownership-texture", { width: INK_TEXTURE_SIZE, height: INK_TEXTURE_SIZE }, scene, false);
  const inkContext = inkTexture.getContext();
  inkContext.fillStyle = NEUTRAL_GROUND_COLOR;
  inkContext.fillRect(0, 0, INK_TEXTURE_SIZE, INK_TEXTURE_SIZE);
  commitInkTexture(inkTexture);
  floorMaterial.diffuseTexture = inkTexture;
  floorMaterial.specularColor = new Color3(0.08, 0.08, 0.07);
  floor.material = floorMaterial;

  const wallMaterial = makeMaterial("wall-material", new Color3(0.12, 0.18, 0.14));
  const size = ARENA_HALF_SIZE * 2 + 1;
  const walls = [
    { x: 0, z: -ARENA_HALF_SIZE - 0.25, width: size, depth: 0.5 },
    { x: 0, z: ARENA_HALF_SIZE + 0.25, width: size, depth: 0.5 },
    { x: -ARENA_HALF_SIZE - 0.25, z: 0, width: 0.5, depth: size },
    { x: ARENA_HALF_SIZE + 0.25, z: 0, width: 0.5, depth: size }
  ];
  walls.forEach((wall, index) => {
    const mesh = MeshBuilder.CreateBox(`wall-${index}`, { width: wall.width, depth: wall.depth, height: ARENA_WALL_HEIGHT }, scene);
    mesh.position.set(wall.x, ARENA_WALL_HEIGHT / 2, wall.z);
    mesh.material = wallMaterial;
  });
  ARENA_OBSTACLES.forEach((box, index) => {
    const mesh = MeshBuilder.CreateBox(`cover-${index}`, { width: box.width, depth: box.depth, height: box.height }, scene);
    mesh.position.set(box.x, box.height / 2, box.z);
    mesh.material = makeMaterial(`cover-${index}-material`, new Color3(0.52, 0.57, 0.5));
  });
  WALL_SURFACES.forEach(createWallPaintSurface);
}

function applyPaintStamp(stamp: PaintStamp) {
  if (paintHistory.has(stamp.id)) return;
  paintHistory.set(stamp.id, stamp);
  if (currentRoomId) {
    sessionStorage.setItem(PAINT_HISTORY_STORAGE_KEY, JSON.stringify({ roomId: currentRoomId, stamps: [...paintHistory.values()] }));
  }
  inkField.paint(stamp);
  if (stamp.surfaceId === "ground") {
    const context = inkTexture.getContext();
    const uv = groundPointToCanvasUv(stamp);
    const textureX = uv.u * INK_TEXTURE_SIZE;
    const textureY = uv.v * INK_TEXTURE_SIZE;
    const textureRadius = stamp.radius / (ARENA_HALF_SIZE * 2) * INK_TEXTURE_SIZE;
    context.fillStyle = TEAM_COLOR_CSS[stamp.team];
    context.beginPath();
    context.arc(textureX, textureY, textureRadius, 0, Math.PI * 2);
    context.fill();
    commitInkTexture(inkTexture);
    return;
  }
  const surface = WALL_SURFACES.find((candidate) => candidate.id === stamp.surfaceId);
  const texture = wallInkTextures.get(stamp.surfaceId);
  if (!surface || !texture) return;
  const context = texture.getContext();
  const uv = wallPointToCanvasUv(surface, stamp);
  const textureX = uv.u * INK_TEXTURE_SIZE;
  const textureY = uv.v * INK_TEXTURE_SIZE;
  const radiusX = stamp.radius / (surface.maxAlong - surface.minAlong) * INK_TEXTURE_SIZE;
  const radiusY = stamp.radius / surface.height * INK_TEXTURE_SIZE;
  context.fillStyle = TEAM_COLOR_CSS[stamp.team];
  context.save();
  context.translate(textureX, textureY);
  context.scale(1, radiusY / radiusX);
  context.beginPath();
  context.arc(0, 0, radiusX, 0, Math.PI * 2);
  context.fill();
  context.restore();
  commitInkTexture(texture);
}

function createWallPaintSurface(surface: (typeof WALL_SURFACES)[number]) {
  const width = surface.maxAlong - surface.minAlong;
  const plane = MeshBuilder.CreatePlane(`paint-surface-${surface.id}`, {
    width,
    height: surface.height,
    sideOrientation: Mesh.FRONTSIDE
  }, scene);
  const alongCenter = (surface.minAlong + surface.maxAlong) / 2;
  if (surface.axis === "x") {
    plane.position.set(surface.coordinate + surface.normalX * 0.012, surface.height / 2, alongCenter);
    plane.rotation.y = surface.normalX < 0 ? Math.PI / 2 : -Math.PI / 2;
  } else {
    plane.position.set(alongCenter, surface.height / 2, surface.coordinate + surface.normalZ * 0.012);
    plane.rotation.y = surface.normalZ < 0 ? 0 : Math.PI;
  }
  const texture = new DynamicTexture(`wall-ink-${surface.id}`, { width: INK_TEXTURE_SIZE, height: INK_TEXTURE_SIZE }, scene, false);
  const context = texture.getContext();
  context.fillStyle = surface.id.startsWith("obstacle-") ? NEUTRAL_COVER_COLOR : NEUTRAL_ARENA_WALL_COLOR;
  context.fillRect(0, 0, INK_TEXTURE_SIZE, INK_TEXTURE_SIZE);
  commitInkTexture(texture);
  const material = new StandardMaterial(`wall-ink-material-${surface.id}`, scene);
  material.diffuseTexture = texture;
  material.backFaceCulling = true;
  material.specularColor = new Color3(0.06, 0.07, 0.06);
  plane.material = material;
  wallInkTextures.set(surface.id, texture);
}

function commitInkTexture(texture: DynamicTexture) {
  // All world-to-canvas transforms use a top-left Canvas origin. Keep the
  // Babylon upload orientation fixed here so callers cannot invert it ad hoc.
  texture.update(true);
}

function createTofu(id: string, team: TeamId): PlayerMesh {
  const root = new TransformNode(`tofu-${id}`, scene);
  const body = MeshBuilder.CreateBox(`body-${id}`, { width: 0.82, height: 1.18, depth: 0.72 }, scene);
  body.parent = root;
  body.position.y = 0.61;
  const material = makeMaterial(`tofu-material-${id}`, TEAM_COLORS[team]);
  body.material = material;
  const eyeMaterial = makeMaterial(`eyes-${id}`, new Color3(0.08, 0.1, 0.08));
  for (const x of [-0.18, 0.18]) {
    const eye = MeshBuilder.CreateSphere(`eye-${id}-${x}`, { diameter: 0.1, segments: 8 }, scene);
    eye.parent = root;
    eye.position.set(x, 0.77, 0.37);
    eye.material = eyeMaterial;
  }
  const band = MeshBuilder.CreateBox(`band-${id}`, { width: 0.88, height: 0.13, depth: 0.78 }, scene);
  band.parent = root;
  band.position.y = 0.99;
  band.material = makeMaterial(`band-material-${id}`, TEAM_COLORS[team === 0 ? 1 : 0].scale(0.7));
  const nozzle = MeshBuilder.CreateCylinder(`nozzle-${id}`, { height: 0.62, diameter: 0.14, tessellation: 10 }, scene);
  nozzle.parent = root;
  nozzle.position.set(0.34, 0.8, 0.42);
  nozzle.rotation.x = Math.PI / 2;
  nozzle.material = band.material;
  return {
    root,
    material,
    targetPosition: Vector3.Zero(),
    velocity: Vector3.Zero(),
    targetYaw: 0,
    diving: false
  };
}

function createBullet(id: string, team: TeamId): BulletMesh {
  const bullet = MeshBuilder.CreateSphere(`soy-bullet-${id}`, { diameter: 0.26, segments: 10 }, scene);
  const material = makeMaterial(`bullet-material-${id}`, TEAM_COLORS[team]);
  material.emissiveColor = material.diffuseColor.scale(0.55);
  bullet.material = material;
  return { mesh: bullet, targetPosition: Vector3.Zero(), velocity: Vector3.Zero() };
}

function removePlayer(id: string) {
  players.delete(id);
  playerMeshes.get(id)?.root.dispose();
  playerMeshes.delete(id);
  lastStateSequence.delete(id);
}

function removeBullet(id: string) {
  bullets.delete(id);
  bulletMeshes.get(id)?.mesh.dispose();
  bulletMeshes.delete(id);
}

function makeMaterial(name: string, color: Color3) {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = color;
  material.specularColor = new Color3(0.08, 0.08, 0.07);
  return material;
}

function renderPlayersHud() {
  playersHud.innerHTML = [...players.values()].map((player) => {
    const hpColor = player.hp > 50 ? "#43ad61" : player.hp > 0 ? "#e5a83c" : "#bd4034";
    const team = player.team === 0 ? "橙" : "青";
    return `<div class="player-card"><div class="player-line"><strong>${team} · ${escapeHtml(player.name)}${player.id === localSessionId ? " · 你" : ""}</strong><span>${player.hp}/${PLAYER_MAX_HP}</span></div><div class="hp-track"><div class="hp-fill" style="width:${player.hp}%;background:${hpColor}"></div></div></div>`;
  }).join("");
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
