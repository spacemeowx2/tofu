import "./style.css";
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import {
  PLAYER_MAX_HP,
  PROTOCOL_VERSION,
  type PeerPacket,
  type PaintStamp,
  type PlayerSnapshot,
  type TeamId
} from "@tofu/protocol";
import {
  createPlayer,
  respawnPlayer,
  SPLATTERSHOT_PROFILE,
  WALL_SURFACES
} from "@tofu/simulation";
import type { InkTileSnapshot } from "@tofu/simulation/ink";
import { AnalyticPhysicsAdapter } from "@tofu/simulation/physics";
import { createRapierPhysicsAdapter } from "@tofu/simulation/rapier-physics";
import { TOFU_TEST_LEVEL } from "@tofu/simulation/level";
import { SPLATTERSHOT, findWeaponDefinition } from "@tofu/simulation/weapons";
import { GameWorld, type GameWorldEvent } from "@tofu/simulation/world";
import { ThirdPersonCamera } from "./camera/ThirdPersonCamera";
import { GameRuntime } from "./game/GameRuntime";
import { InputController } from "./input/InputController";
import { PeerSession, type OutgoingPeerPacket } from "./network/PeerSession";
import { GameRenderer } from "./rendering/GameRenderer";
import { ColyseusRelayTransport, type GameTransport, type PeerInfo } from "./transport";

const SIMULATION_STEP = 1 / 60;
const STATE_SEND_INTERVAL = 1 / 20;
const RESPAWN_SECONDS = 2.5;
const PEER_ID_STORAGE_KEY = "tofu.peerId";
const PLAYER_STATE_STORAGE_KEY = "tofu.playerState";

const canvas = document.querySelector<HTMLCanvasElement>("#game")!;
const status = document.querySelector<HTMLDivElement>("#status")!;
const playersHud = document.querySelector<HTMLDivElement>("#players")!;
const feed = document.querySelector<HTMLDivElement>("#feed")!;
const controls = document.querySelector<HTMLDivElement>("#controls")!;
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
const scene = new Scene(engine);

const cameraRig = new ThirdPersonCamera(scene);
const gameRenderer = new GameRenderer(scene, TOFU_TEST_LEVEL, WALL_SURFACES);

const endpoint = `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:2567`;
const transport: GameTransport = new ColyseusRelayTransport(endpoint);
const peerSession = new PeerSession(transport);
const gameWorld = new GameWorld(
  TOFU_TEST_LEVEL,
  new AnalyticPhysicsAdapter(TOFU_TEST_LEVEL)
);
const players = gameWorld.players;
const bullets = gameWorld.bullets;
const roster = new Map<string, PeerInfo>();
const lastStateSequence = new Map<string, number>();
const processedHits = new Set<string>();
const inkField = gameWorld.ink;

let localSessionId = "";
let currentRoomId = "";
let localPlayer: PlayerSnapshot | undefined;
let bulletSequence = 0;
let respawnRemaining = 0;
let mouseFiring = false;
let fireAccumulator = 0;
let rosterSignature = "";

const inputController = new InputController(canvas, controls, {
  onLook(deltaX, deltaY) {
    cameraRig.look(deltaX, deltaY);
    cameraRig.updateAim(localPlayer, SPLATTERSHOT);
  },
  onFireChanged: setMouseFiring
});

const runtime = new GameRuntime({
  fixedStepSeconds: SIMULATION_STEP,
  stateSendIntervalSeconds: STATE_SEND_INTERVAL,
  onFixedStep: stepLocalSimulation,
  onStateSend: broadcastLocalState,
  onFrame(dt) {
    updateContinuousFire(dt);
    gameRenderer.update(dt, localSessionId);
    gameRenderer.followLocalPlayer(cameraRig, localSessionId);
    scene.render();
  }
});

window.addEventListener("resize", () => engine.resize());
window.addEventListener("beforeunload", () => {
  inputController.dispose();
  gameWorld.dispose();
  void peerSession.close();
});

void bootstrap();

async function bootstrap() {
  try {
    gameWorld.replacePhysics(await createRapierPhysicsAdapter(TOFU_TEST_LEVEL));
  } catch (error) {
    addFeed(`Rapier 初始化失败，使用解析碰撞：${error instanceof Error ? error.message : String(error)}`);
  }
  engine.runRenderLoop(() => runtime.advance(engine.getDeltaTime() / 1000));
  await connect();
}

async function connect() {
  const params = new URLSearchParams(location.search);
  const name = params.get("name") || `豆腐${Math.floor(100 + Math.random() * 900)}`;
  const stablePeerId = getOrCreatePeerId();
  try {
    const session = await peerSession.connect(name, stablePeerId, handlePeerPacket, syncRoster);
    localSessionId = session.peerId;
    currentRoomId = session.roomId;
    syncRoster([...roster.values()]);
    const teamPeers = [...roster.values()].filter((peer) => peer.team === session.team).sort((a, b) => a.id.localeCompare(b.id));
    const teamSlot = Math.max(0, teamPeers.findIndex((peer) => peer.id === localSessionId));
    const player = restoreLocalPlayer(localSessionId, name, session.team, currentRoomId) ?? createPlayer(localSessionId, name, session.team, teamSlot);
    localPlayer = gameWorld.upsertPlayer(player);
    gameRenderer.syncPlayer(localPlayer, true);
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
    if (rosterChanged) replayInkTiles();
  }
}

function handlePeerPacket(packet: PeerPacket) {
  if (packet.protocolVersion !== PROTOCOL_VERSION || packet.peerId === localSessionId) return;
  if (packet.kind === "player_state") {
    if (packet.player.id !== packet.peerId || packet.sequence <= (lastStateSequence.get(packet.peerId) ?? -1)) return;
    lastStateSequence.set(packet.peerId, packet.sequence);
    const snapshot = gameWorld.upsertPlayer(packet.player);
    gameRenderer.syncPlayer(snapshot, false);
    renderPlayersHud();
    return;
  }
  if (packet.kind === "shot") {
    if (
      packet.bullet.ownerId !== packet.peerId ||
      bullets.has(packet.bullet.id) ||
      !findWeaponDefinition(packet.bullet.weaponId)
    ) return;
    gameWorld.addBullet(packet.bullet);
    gameRenderer.syncBullet(packet.bullet);
    return;
  }
  if (packet.kind === "bullet_removed") {
    removeBullet(packet.bulletId);
    return;
  }
  if (packet.kind === "paint") {
    if (packet.stamps.length > 16 || packet.stamps.some((stamp) => roster.get(packet.peerId)?.team !== stamp.team)) return;
    packet.stamps.forEach(applyPaintStamp);
    return;
  }
  if (packet.kind === "ink_tile") {
    const tile = packet.tile as InkTileSnapshot;
    if (tile.owners.length > 256 || tile.ticks.length > 256 || !gameWorld.applyInkTile(tile)) return;
    gameRenderer.applyInkTile(tile);
    return;
  }
  if (packet.kind === "hit" && packet.targetId === localSessionId && localPlayer) {
    const hitKey = `${packet.peerId}:${packet.bulletId}`;
    const weapon = findWeaponDefinition(packet.weaponId);
    if (processedHits.has(hitKey) || !weapon || packet.damage !== weapon.damage || !localPlayer.alive) return;
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
    gameRenderer.syncPlayer(localPlayer, true);
    broadcastLocalState();
    renderPlayersHud();
  }
}

function stepLocalSimulation(dt: number) {
  if (!localPlayer) return;
  if (!localPlayer.alive) {
    respawnRemaining -= dt;
    if (respawnRemaining <= 0) {
      respawnPlayer(localPlayer, 0, TOFU_TEST_LEVEL);
      addFeed("你已重新凝固");
      broadcastLocalState();
    }
  }

  let input;
  if (localPlayer.alive) {
    const axes = inputController.movementAxes();
    const movement = cameraRig.movement(axes.strafe, axes.advance);
    const wallContact = gameWorld.wallContactFor(localPlayer);
    const wallTeam = wallContact
      ? inkField.teamAtWall(wallContact.id, wallContact.x, wallContact.y, wallContact.z)
      : null;
    input = {
      moveX: movement.x,
      moveZ: movement.z,
      jumpPressed: inputController.consumeJump(),
      diving: inputController.isDiving(),
      groundTeam: inkField.teamAt(localPlayer.x, localPlayer.z),
      wallContact: wallContact ? { ...wallContact, team: wallTeam } : undefined
    };
  }

  const events = gameWorld.step(localSessionId, input, dt);
  peerSession.setSimulationTick(gameWorld.tick);
  gameRenderer.syncPlayer(localPlayer, true);
  bullets.forEach((bullet) => gameRenderer.syncBullet(bullet));
  events.forEach(handleWorldEvent);
  gameRenderer.pruneBullets(bullets);
}

function handleWorldEvent(event: GameWorldEvent) {
  if (event.kind === "paint") {
    emitPaintStamps(event.stamps, false);
    return;
  }
  if (event.kind === "hit") {
    sendPacket({
      kind: "hit",
      bulletId: event.bulletId,
      weaponId: event.weaponId,
      targetId: event.targetId,
      damage: event.damage
    });
    addFeed(`你命中 ${players.get(event.targetId)?.name ?? "对手"}，造成 ${event.damage} 点伤害`);
    return;
  }
  sendPacket({ kind: "bullet_removed", bulletId: event.bulletId });
  removeBullet(event.bulletId);
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
  const interval = SPLATTERSHOT_PROFILE.fireIntervalSeconds;
  while (fireAccumulator >= interval) {
    fireAccumulator -= interval;
    shoot();
  }
}

function shoot() {
  if (!localPlayer?.alive || localPlayer.diving) return;
  cameraRig.updateAim(localPlayer, SPLATTERSHOT);
  const forward = cameraRig.forward();
  const right = cameraRig.right();
  const aim = cameraRig.aimDirection();
  const shotIndex = ++bulletSequence;
  const result = gameWorld.shoot(
    localSessionId,
    `${localSessionId}:${shotIndex}`,
    SPLATTERSHOT.id,
    { x: aim.x, y: aim.y, z: aim.z },
    { x: forward.x, z: forward.z },
    { x: right.x, z: right.z },
    shotIndex
  );
  if (!result) return;
  gameRenderer.syncBullet(result.bullet);
  sendPacket({ kind: "shot", bullet: result.bullet });
  result.events.forEach(handleWorldEvent);
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

function replayInkTiles() {
  gameWorld.ink.snapshot().tiles.forEach((tile) => {
    sendPacket({ kind: "ink_tile", tile });
  });
}

function sendPacket(payload: OutgoingPeerPacket) {
  if (!localSessionId) return;
  peerSession.setSimulationTick(gameWorld.tick);
  peerSession.send(payload);
}

function emitPaintStamps(stamps: PaintStamp[], applyToWorld = true) {
  if (stamps.length === 0) return;
  if (applyToWorld) gameWorld.applyPaint(stamps);
  stamps.forEach((stamp) => gameRenderer.applyPaintStamp(stamp));
  sendPacket({ kind: "paint", stamps });
}

function applyPaintStamp(stamp: PaintStamp) {
  gameWorld.applyPaint([stamp]);
  gameRenderer.applyPaintStamp(stamp);
}

function removePlayer(id: string) {
  players.delete(id);
  gameRenderer.removePlayer(id);
  lastStateSequence.delete(id);
}

function removeBullet(id: string) {
  bullets.delete(id);
  gameRenderer.removeBullet(id);
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
