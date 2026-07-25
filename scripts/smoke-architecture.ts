import assert from "node:assert/strict";
import { PROTOCOL_VERSION, type PeerPacket } from "../packages/protocol/src/index.js";
import { GameRuntime } from "../apps/client/src/game/GameRuntime.js";
import { GameSession } from "../apps/client/src/network/GameSession.js";
import type { GameRenderer } from "../apps/client/src/rendering/GameRenderer.js";
import type {
  GameTransport,
  PeerInfo,
  TransportSession
} from "../apps/client/src/transport.js";
import type { HudView } from "../apps/client/src/ui/HudView.js";
import { groundPointToCanvasUv } from "../packages/simulation/src/coordinates.js";
import { TiledInkField } from "../packages/simulation/src/ink.js";
import {
  COMPACT_TEST_LEVEL,
  TOFU_TEST_LEVEL,
  createLevelWallSurfaces
} from "../packages/simulation/src/level.js";
import { createRapierPhysicsAdapter } from "../packages/simulation/src/rapier-physics.js";
import {
  DEFAULT_WEAPONS,
  SPLATTERSHOT,
  SPLATTERSHOT_JR
} from "../packages/simulation/src/weapons.js";
import { GameWorld } from "../packages/simulation/src/world.js";

class FakeTransport implements GameTransport {
  readonly sent: PeerPacket[] = [];
  private packetListener?: (packet: PeerPacket) => void;
  private peersListener?: (peers: PeerInfo[]) => void;
  private peers: PeerInfo[] = [];

  setPeers(peers: PeerInfo[]) {
    this.peers = peers;
    this.peersListener?.(peers);
  }

  emit(packet: PeerPacket) {
    this.packetListener?.(packet);
  }

  async connect(_name: string, peerId: string): Promise<TransportSession> {
    this.peersListener?.(this.peers);
    const local = this.peers.find((peer) => peer.id === peerId)!;
    return {
      peerId,
      roomId: "architecture-room",
      team: local.team,
      coordinatorId: peerId,
      epoch: 1
    };
  }

  send(packet: PeerPacket) {
    this.sent.push(packet);
  }

  onPacket(listener: (packet: PeerPacket) => void) {
    this.packetListener = listener;
    return () => { this.packetListener = undefined; };
  }

  onPeersChanged(listener: (peers: PeerInfo[]) => void) {
    this.peersListener = listener;
    return () => { this.peersListener = undefined; };
  }

  async close() {}
}

let fixedSteps = 0;
let stateSends = 0;
let maintenanceRuns = 0;
let frameSeconds = 0;
const runtime = new GameRuntime({
  fixedStepSeconds: 1 / 60,
  stateSendIntervalSeconds: 1 / 20,
  maintenanceIntervalSeconds: 1 / 15,
  onFixedStep: () => fixedSteps += 1,
  onStateSend: () => stateSends += 1,
  onMaintenance: () => maintenanceRuns += 1,
  onFrame: (dt) => frameSeconds += dt
});
runtime.advance(1 / 30);
runtime.advance(1 / 30);
assert.equal(fixedSteps, 4, "fixed-step runtime lost simulation ticks");
assert.equal(stateSends, 1, "state transmission was not independently scheduled");
assert.equal(maintenanceRuns, 1, "ink maintenance was not independently scheduled");
assert.ok(frameSeconds > 0.06, "render-frame delta was not preserved");

assert.equal(DEFAULT_WEAPONS.get(SPLATTERSHOT.id), SPLATTERSHOT);
assert.equal(DEFAULT_WEAPONS.get(SPLATTERSHOT_JR.id), SPLATTERSHOT_JR);
assert.equal(DEFAULT_WEAPONS.list().length, 2, "second weapon is not registered");
assert.equal(
  createLevelWallSurfaces(TOFU_TEST_LEVEL).length,
  TOFU_TEST_LEVEL.obstacles.length * 4 + 4
);
assert.notEqual(COMPACT_TEST_LEVEL.halfSize, TOFU_TEST_LEVEL.halfSize);
assert.equal(groundPointToCanvasUv({ x: 0, z: 0 }, COMPACT_TEST_LEVEL.halfSize).u, 0.5);

const orangeStamp = {
  id: "peer-orange:paint",
  team: 0 as const,
  surfaceId: "ground" as const,
  x: 1,
  y: 0,
  z: -2,
  radiusU: 1.2,
  radiusV: 0.8,
  rotation: 0.3
};
const cyanStamp = { ...orangeStamp, id: "peer-cyan:paint", team: 1 as const };
const orangeInk = new TiledInkField(TOFU_TEST_LEVEL);
const cyanInk = new TiledInkField(TOFU_TEST_LEVEL);
orangeInk.paint(orangeStamp, 7);
cyanInk.paint(cyanStamp, 7);
const orangeTiles = orangeInk.takeDirtyTileSnapshots();
const cyanTiles = cyanInk.takeDirtyTileSnapshots();
orangeTiles.forEach((tile) => cyanInk.applyTileSnapshot(tile));
cyanTiles.forEach((tile) => orangeInk.applyTileSnapshot(tile));
assert.deepEqual(
  orangeInk.tileHashes(),
  cyanInk.tileHashes(),
  "equal-tick concurrent paint did not converge by deterministic writer"
);
orangeInk.takeDirtyTileSnapshots();
const convergedTile = cyanInk.snapshotTile(
  cyanTiles[0].surfaceId,
  cyanTiles[0].tileX,
  cyanTiles[0].tileY
)!;
assert.equal(orangeInk.applyTileSnapshot(convergedTile), true);
assert.equal(
  orangeInk.takeDirtyTileSnapshots().length,
  0,
  "identical tile was incorrectly marked dirty and would echo forever"
);

const authoritativeInk = new TiledInkField(TOFU_TEST_LEVEL);
authoritativeInk.paint({ ...cyanStamp, id: "newer-local" }, 10);
const authoritativeTile = authoritativeInk.takeDirtyTileSnapshots()[0];
const staleInk = new TiledInkField(TOFU_TEST_LEVEL);
staleInk.paint({ ...orangeStamp, id: "older-remote" }, 9);
const staleTile = staleInk.takeDirtyTileSnapshots().find(
  (tile) =>
    tile.surfaceId === authoritativeTile.surfaceId &&
    tile.tileX === authoritativeTile.tileX &&
    tile.tileY === authoritativeTile.tileY
)!;
assert.equal(authoritativeInk.applyTileSnapshot(staleTile), true);
assert.equal(
  authoritativeInk.takeDirtyTileSnapshots().length,
  0,
  "stale tile was incorrectly marked dirty"
);
const mergedTile = authoritativeInk.snapshotTile(
  authoritativeTile.surfaceId,
  authoritativeTile.tileX,
  authoritativeTile.tileY
)!;
assert.notDeepEqual(
  mergedTile.owners,
  staleTile.owners,
  "stale incoming tile replaced authoritative ownership"
);
assert.equal(
  authoritativeInk.applyTileSnapshot({ ...staleTile, hash: staleTile.hash ^ 1 }),
  false,
  "tampered ink tile passed hash validation"
);

const rapier = await createRapierPhysicsAdapter(TOFU_TEST_LEVEL);
const world = new GameWorld(TOFU_TEST_LEVEL, rapier);
assert.equal(world.physicsKind, "rapier");
const player = world.createPlayer("architecture-player", "Architecture", 0, SPLATTERSHOT.id);
world.applyPaint([orangeStamp]);
const shot = world.shoot(
  player.id,
  "architecture-shot",
  { x: 0, y: 0.1, z: 1 },
  { x: 0, z: 1 },
  { x: 1, z: 0 },
  SPLATTERSHOT.paint.footEveryShots
);
assert.ok(shot && world.bullets.has(shot.bullet.id), "GameWorld did not own spawned projectile");
assert.ok(shot.events.some((event) => event.kind === "paint"), "weapon data did not drive foot paint");
const input = {
  moveX: 0,
  moveZ: 1,
  jumpPressed: false,
  diving: false,
  groundTeam: world.ink.teamAt(player.x, player.z)
};
world.step(player.id, input, 1 / 60);
const snapshot = world.snapshot();
const restored = new GameWorld(
  TOFU_TEST_LEVEL,
  await createRapierPhysicsAdapter(TOFU_TEST_LEVEL)
);
restored.restore(snapshot);
assert.deepEqual([...restored.players.values()], [...world.players.values()]);
assert.deepEqual([...restored.bullets.values()], [...world.bullets.values()]);
assert.deepEqual(restored.ink.tileHashes(), world.ink.tileHashes());
world.step(player.id, input, 1 / 60);
restored.step(player.id, input, 1 / 60);
assert.deepEqual(
  restored.players.get(player.id),
  world.players.get(player.id),
  "restored world did not continue deterministically"
);

const compactWorld = new GameWorld(
  COMPACT_TEST_LEVEL,
  await createRapierPhysicsAdapter(COMPACT_TEST_LEVEL)
);
const compactPlayer = compactWorld.createPlayer(
  "compact-player",
  "Compact",
  1,
  SPLATTERSHOT_JR.id
);
assert.equal(compactPlayer.x, COMPACT_TEST_LEVEL.spawns[1][0].x);
assert.equal(compactWorld.weaponFor(compactPlayer).id, SPLATTERSHOT_JR.id);
assert.equal(compactWorld.snapshot().levelId, COMPACT_TEST_LEVEL.id);
const compactShot = compactWorld.shoot(
  compactPlayer.id,
  "compact-jr-shot",
  { x: -1, y: 0, z: 0 },
  { x: -1, z: 0 },
  { x: 0, z: 1 },
  SPLATTERSHOT_JR.paint.footEveryShots
);
assert.equal(compactShot?.bullet.weaponId, SPLATTERSHOT_JR.id);
assert.equal(
  compactShot?.events.find((event) => event.kind === "paint")?.tiles.length! > 0,
  true,
  "second weapon did not drive its own world paint event"
);

const sessionWorld = new GameWorld(
  COMPACT_TEST_LEVEL,
  await createRapierPhysicsAdapter(COMPACT_TEST_LEVEL),
  DEFAULT_WEAPONS
);
const sessionPlayer = sessionWorld.createPlayer(
  "session-local",
  "Session Local",
  0,
  SPLATTERSHOT.id
);
const fakeTransport = new FakeTransport();
fakeTransport.setPeers([
  { id: sessionPlayer.id, name: sessionPlayer.name, team: sessionPlayer.team },
  { id: "session-remote", name: "Session Remote", team: 1 }
]);
let renderedTile: ReturnType<GameWorld["inkTile"]>;
const renderedTiles: NonNullable<typeof renderedTile>[] = [];
const fakeRenderer = {
  syncPlayer() {},
  syncBullet() {},
  applyInkTile(tile: NonNullable<typeof renderedTile>) {
    renderedTile = tile;
    renderedTiles.push(tile);
  },
  removePlayer() {},
  removeBullet() {}
} as unknown as GameRenderer;
const fakeHud = {
  renderPlayers() {},
  addFeed() {}
} as unknown as HudView;
const gameSession = new GameSession(
  fakeTransport,
  "architecture-content",
  sessionWorld,
  fakeRenderer,
  fakeHud
);
await gameSession.connect(sessionPlayer.name, sessionPlayer.id);
gameSession.attachLocalPlayer(sessionPlayer);
const hashPackets = fakeTransport.sent.filter((packet) => packet.kind === "ink_hashes");
assert.ok(hashPackets.length > 1, "runtime did not chunk the complete ink hash set");
assert.ok(
  hashPackets.every((packet) => packet.hashes.length <= 24 && JSON.stringify(packet).length < 4096),
  "ink hash packet exceeded the bounded runtime payload"
);

const sessionStamp = {
  ...orangeStamp,
  id: "session-local:newer",
  x: 0,
  z: 0,
  radiusU: 0.6,
  radiusV: 0.6
};
sessionWorld.applyPaint([sessionStamp], 20);
gameSession.broadcastDirtyInkTiles();
const runtimeTilePackets = fakeTransport.sent.filter((packet) => packet.kind === "ink_tile");
assert.ok(runtimeTilePackets.length > 0, "runtime did not consume dirty local tile snapshots");
assert.ok(
  runtimeTilePackets.every((packet) =>
    packet.tile.owners.length <= 64 &&
    packet.tile.writers.length <= 64 &&
    JSON.stringify(packet).length < 4096
  ),
  "runtime ink tile exceeded the bounded payload"
);
const localRuntimeTile = runtimeTilePackets.find((packet) =>
  packet.tile.surfaceId === "ground" &&
  packet.tile.owners.includes(0)
)!;
const remoteStaleInk = new TiledInkField(COMPACT_TEST_LEVEL, 128, 8);
remoteStaleInk.paint({ ...sessionStamp, id: "session-remote:older", team: 1 }, 19);
const remoteStaleTile = remoteStaleInk.snapshotTile(
  localRuntimeTile.tile.surfaceId,
  localRuntimeTile.tile.tileX,
  localRuntimeTile.tile.tileY
)!;
fakeTransport.emit({
  protocolVersion: PROTOCOL_VERSION,
  contentId: "architecture-content",
  levelId: COMPACT_TEST_LEVEL.id,
  physicsKind: "rapier",
  peerId: "session-remote",
  sequence: 1,
  simulationTick: 19,
  kind: "ink_tile",
  tile: remoteStaleTile
});
assert.equal(
  renderedTile?.hash,
  sessionWorld.inkTile(
    remoteStaleTile.surfaceId,
    remoteStaleTile.tileX,
    remoteStaleTile.tileY
  )?.hash,
  "GPU renderer did not receive the post-merge authoritative tile"
);
assert.notEqual(renderedTile?.hash, remoteStaleTile.hash, "GPU renderer received stale remote tile data");

const renderedBeforeLosingPaint = renderedTiles.length;
fakeTransport.emit({
  protocolVersion: PROTOCOL_VERSION,
  contentId: "architecture-content",
  levelId: COMPACT_TEST_LEVEL.id,
  physicsKind: "rapier",
  peerId: "session-remote",
  sequence: 2,
  simulationTick: 19,
  kind: "paint",
  stamps: [{ ...sessionStamp, id: "session-remote:losing-stamp", team: 1 }]
});
assert.equal(
  renderedTiles.length,
  renderedBeforeLosingPaint,
  "rejected paint stamp bypassed ownership and reached the GPU renderer"
);

const requestsBeforeIncompatiblePeer = fakeTransport.sent.filter(
  (packet) => packet.kind === "ink_tile_request"
).length;
fakeTransport.emit({
  protocolVersion: PROTOCOL_VERSION,
  contentId: "architecture-content",
  levelId: COMPACT_TEST_LEVEL.id,
  physicsKind: "analytic",
  peerId: "session-remote",
  sequence: 3,
  simulationTick: 21,
  kind: "ink_hashes",
  hashes: [{
    surfaceId: localRuntimeTile.tile.surfaceId,
    tileX: localRuntimeTile.tile.tileX,
    tileY: localRuntimeTile.tile.tileY,
    hash: localRuntimeTile.tile.hash ^ 1
  }]
});
assert.equal(
  fakeTransport.sent.filter((packet) => packet.kind === "ink_tile_request").length,
  requestsBeforeIncompatiblePeer,
  "analytic peer packet entered a Rapier session"
);

fakeTransport.emit({
  protocolVersion: PROTOCOL_VERSION,
  contentId: "architecture-content",
  levelId: COMPACT_TEST_LEVEL.id,
  physicsKind: "rapier",
  peerId: "session-remote",
  sequence: 4,
  simulationTick: 21,
  kind: "ink_hashes",
  hashes: [{
    surfaceId: localRuntimeTile.tile.surfaceId,
    tileX: localRuntimeTile.tile.tileX,
    tileY: localRuntimeTile.tile.tileY,
    hash: localRuntimeTile.tile.hash ^ 1
  }]
});
const requestPacket = [...fakeTransport.sent].reverse().find(
  (packet) => packet.kind === "ink_tile_request"
);
assert.equal(requestPacket?.targetPeerId, "session-remote");
assert.ok(requestPacket && JSON.stringify(requestPacket).length < 4096);

const impact = rapier.castProjectile(
  { x: -6.5, y: 1, z: 0 },
  { x: -4.95, y: 1, z: 0 },
  0.2
);
assert.equal(impact?.impact.surfaceId, "obstacle-0-nx");

world.dispose();
restored.dispose();
compactWorld.dispose();
sessionWorld.dispose();

console.log(JSON.stringify({
  ok: true,
  fixedSteps,
  weapons: DEFAULT_WEAPONS.list().map(({ id }) => id),
  levels: [TOFU_TEST_LEVEL.id, COMPACT_TEST_LEVEL.id],
  convergedInkTiles: orangeTiles.length + cyanTiles.length,
  boundedRuntimeHashPackets: hashPackets.length,
  worldSnapshotTick: snapshot.tick,
  physics: "rapier-only-production"
}, null, 2));
