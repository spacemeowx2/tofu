import { ColyseusSDK, type Room } from "@colyseus/sdk";
import {
  PROTOCOL_VERSION,
  ROOM_NAME,
  type PeerPacket,
  type RelayedPeerPacket
} from "@tofu/protocol";
import { groundPointToCanvasUv, wallPointToCanvasUv } from "../packages/simulation/src/coordinates.js";
import { TOFU_DEMO_CONTENT } from "../packages/simulation/src/content.js";
import { TOFU_TEST_LEVEL, createLevelWallSurfaces } from "../packages/simulation/src/level.js";
import { createRapierPhysicsAdapter } from "../packages/simulation/src/rapier-physics.js";
import { SPLATTERSHOT } from "../packages/simulation/src/weapons.js";
import { GameWorld } from "../packages/simulation/src/world.js";

type Peer = { id: string; name: string; team: number };
type PeerMap = { get(id: string): Peer | undefined; get size(): number };
type LobbyState = { peers: PeerMap; authorityMode: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const clientA = new ColyseusSDK("ws://localhost:2567");
const clientB = new ColyseusSDK("ws://localhost:2567");
const clientBReconnect = new ColyseusSDK("ws://localhost:2567");
const peerIdA = "smoke-a-stable";
const peerIdB = "smoke-b-stable";
let roomA: Room | undefined;
let roomB: Room | undefined;
const worlds: GameWorld[] = [];

async function createWorld() {
  const world = new GameWorld(
    TOFU_TEST_LEVEL,
    await createRapierPhysicsAdapter(TOFU_TEST_LEVEL)
  );
  worlds.push(world);
  return world;
}

try {
  roomA = await clientA.create(ROOM_NAME, { name: "Smoke-A", peerId: peerIdA });
  roomB = await clientB.joinById(roomA.roomId, { name: "Smoke-B", peerId: peerIdB });
  await sleep(200);

  const lobby = roomA.state as LobbyState;
  const peerA = lobby.peers.get(peerIdA);
  const peerB = lobby.peers.get(peerIdB);
  if (!peerA || !peerB || lobby.peers.size !== 2) throw new Error("peer roster did not synchronize");
  if (peerA.team === peerB.team) throw new Error("two peers were assigned to the same team");
  if (lobby.authorityMode !== "peer" || "players" in lobby || "bullets" in lobby) {
    throw new Error("relay room unexpectedly owns gameplay state");
  }

  const relayWorld = await createWorld();
  const relayPlayer = relayWorld.createPlayer(
    peerIdA,
    peerA.name,
    peerA.team as 0 | 1,
    SPLATTERSHOT.id
  );
  const packet: PeerPacket = {
    protocolVersion: PROTOCOL_VERSION,
    contentId: TOFU_DEMO_CONTENT.id,
    levelId: TOFU_TEST_LEVEL.id,
    physicsKind: "rapier",
    kind: "player_state",
    peerId: peerIdA,
    sequence: 1,
    simulationTick: 10,
    inkRevision: 0,
    player: { ...relayPlayer }
  };
  let received: RelayedPeerPacket | undefined;
  roomB.onMessage<RelayedPeerPacket>("peer_packet", (message) => { received = message; });
  roomA.send("peer_packet", packet);
  const relayDeadline = Date.now() + 1000;
  while (!received && Date.now() < relayDeadline) await sleep(20);
  if (!received || received.from !== peerIdA || received.packet.kind !== "player_state") {
    throw new Error("peer packet was not relayed intact");
  }
  received = undefined;
  roomA.send("peer_packet", { ...packet, peerId: peerIdB, sequence: 2 });
  await sleep(150);
  if (received) throw new Error("relay accepted a spoofed peer owner");

  const originalTeam = peerB.team;
  await roomB.leave();
  roomB = await clientBReconnect.joinById(roomA.roomId, { name: "Smoke-B", peerId: peerIdB });
  await sleep(200);
  const reconnectedPeer = (roomA.state as LobbyState).peers.get(peerIdB);
  if (!reconnectedPeer || reconnectedPeer.team !== originalTeam) {
    throw new Error("reconnect changed the peer's original team");
  }

  const movementWorld = await createWorld();
  const walker = movementWorld.createPlayer("walk", "walk", 0, SPLATTERSHOT.id);
  const swimmer = movementWorld.createPlayer("swim", "swim", 0, SPLATTERSHOT.id);
  if (movementWorld.ink.teamAt(swimmer.x, swimmer.z) !== null) {
    throw new Error("ink field was not neutral at match start");
  }
  movementWorld.applyPaint([{
    id: "own-ground",
    team: 0,
    kind: "impact",
    originX: swimmer.x,
    originY: 0,
    originZ: swimmer.z + 3,
    surfaceId: "ground",
    x: swimmer.x,
    y: 0,
    z: swimmer.z + 3,
    radiusU: 4,
    radiusV: 4,
    rotation: 0
  }]);
  const batchStartTick = movementWorld.tick;
  for (let tick = 0; tick < 60; tick += 1) {
    movementWorld.step([
      {
        playerId: walker.id,
        input: { moveX: 0, moveZ: 1, jumpPressed: false, diving: false }
      },
      {
        playerId: swimmer.id,
        input: { moveX: 0, moveZ: 1, jumpPressed: false, diving: true }
      }
    ], 1 / 60);
  }
  if (movementWorld.tick - batchStartTick !== 60) {
    throw new Error("multi-authority batch advanced the global tick more than once");
  }
  if (swimmer.z - walker.z < 1) throw new Error("own-color dive speed was not data-owned by GameWorld");

  const jumper = movementWorld.createPlayer("jump", "jump", 0, SPLATTERSHOT.id);
  movementWorld.step([{
    playerId: jumper.id,
    input: { moveX: 0, moveZ: 0, jumpPressed: true, diving: false }
  }], 1 / 60);
  if (jumper.y <= 0 || jumper.vy <= 0) throw new Error("jump was not simulated by GameWorld");

  const climber = movementWorld.createPlayer("climber", "climber", 0, SPLATTERSHOT.id);
  movementWorld.upsertPlayer({ ...climber, x: -5.92, z: 0 });
  movementWorld.applyPaint([{
    id: "own-wall",
    team: 0,
    kind: "impact",
    originX: -5.6,
    originY: 0.5,
    originZ: 0,
    surfaceId: "obstacle-0-nx",
    x: -5.6,
    y: 0.5,
    z: 0,
    radiusU: 1.25,
    radiusV: 1.25,
    rotation: 0
  }]);
  if (!movementWorld.wallContactFor(climber.id)) {
    throw new Error("Rapier wall contact was not detected");
  }
  movementWorld.step([{
    playerId: climber.id,
    input: { moveX: 1, moveZ: 0, jumpPressed: false, diving: true }
  }], 1 / 60);
  if (!climber.wallAttached || climber.y <= 0) {
    throw new Error("Shift did not attach and climb on own-color wall ink");
  }

  const projectileWorld = await createWorld();
  const shooter = projectileWorld.createPlayer("shooter", "shooter", 0, SPLATTERSHOT.id);
  const spreadShots = Array.from({ length: 24 }, (_, index) => projectileWorld.shoot(
    shooter.id,
    `spread:${index}`,
    { x: 0, y: 0, z: 1 },
    { x: 0, z: 1 },
    { x: 1, z: 0 },
    index + 1
  )!.bullet);
  if (!spreadShots.some((bullet) => bullet.dx < 0) || !spreadShots.some((bullet) => bullet.dx > 0)) {
    throw new Error("weapon definition did not produce deterministic fan spread");
  }
  const upward = projectileWorld.shoot(
    shooter.id,
    "aim-up",
    { x: 0, y: 0.5, z: 0.866 },
    { x: 0, z: 1 },
    { x: 1, z: 0 },
    25
  )!.bullet;
  const downward = projectileWorld.shoot(
    shooter.id,
    "aim-down",
    { x: 0, y: -0.5, z: 0.866 },
    { x: 0, z: 1 },
    { x: 1, z: 0 },
    26
  )!.bullet;
  if (upward.dy <= 0.3 || downward.dy >= -0.3) {
    throw new Error("weapon discarded aim pitch");
  }

  const arc = projectileWorld.shoot(
    shooter.id,
    "arc",
    { x: 0.2, y: 0.25, z: 0.2 },
    { x: 0, z: 1 },
    { x: 1, z: 0 },
    27
  )!.bullet;
  const initialDy = arc.dy;
  let arcFell = false;
  let paintEvents = 0;
  let impactSurface = "";
  for (let tick = 0; tick < 180 && projectileWorld.bullets.has(arc.id); tick += 1) {
    for (const event of projectileWorld.step([{ playerId: shooter.id }], 1 / 60)) {
      if (event.kind === "paint") {
        paintEvents += 1;
        impactSurface = event.stamps[0]?.surfaceId ?? impactSurface;
      }
    }
    arcFell ||= (projectileWorld.bullets.get(arc.id)?.dy ?? -Infinity) < initialDy;
  }
  if (projectileWorld.bullets.has(arc.id) || !arcFell || paintEvents === 0) {
    throw new Error("projectile arc did not produce world-owned paint");
  }

  const surfaces = createLevelWallSurfaces(TOFU_TEST_LEVEL);
  const groundNorthWest = groundPointToCanvasUv(
    { x: -TOFU_TEST_LEVEL.halfSize, z: TOFU_TEST_LEVEL.halfSize },
    TOFU_TEST_LEVEL.halfSize
  );
  const groundSouthEast = groundPointToCanvasUv(
    { x: TOFU_TEST_LEVEL.halfSize, z: -TOFU_TEST_LEVEL.halfSize },
    TOFU_TEST_LEVEL.halfSize
  );
  if (
    groundNorthWest.u !== 0 ||
    groundNorthWest.v !== 0 ||
    groundSouthEast.u !== 1 ||
    groundSouthEast.v !== 1
  ) throw new Error("ground transform is mirrored");
  const xWall = surfaces.find((surface) => surface.id === "obstacle-0-nx")!;
  const xWallTopStart = wallPointToCanvasUv(
    xWall,
    { x: xWall.coordinate, y: xWall.height, z: xWall.minAlong }
  );
  if (xWallTopStart.u !== 1 || xWallTopStart.v !== 0) {
    throw new Error("wall transform does not match plane orientation");
  }

  const target = projectileWorld.createPlayer("target", "target", 1, SPLATTERSHOT.id);
  projectileWorld.addBullet({
    id: "hit-probe",
    ownerId: shooter.id,
    team: shooter.team,
    x: target.x,
    y: 1.1,
    z: target.z,
    dx: 0,
    dy: 0,
    dz: 1,
    age: 0,
    distanceTraveled: 0,
    paintTrailIndex: 0,
    seed: 11,
    weaponId: shooter.weaponId
  });
  const hit = projectileWorld
    .step([{ playerId: shooter.id }], 1 / 600)
    .find((event) => event.kind === "hit");
  if (!hit) throw new Error("GameWorld capsule hit detection did not produce a hit event");

  console.log(JSON.stringify({
    ok: true,
    mode: "peer-owned simulation over central relay",
    roomId: roomA.roomId,
    reconnectPreservedTeam: true,
    ownInkDiveGain: Number((swimmer.z - walker.z).toFixed(2)),
    wallAttachAndClimb: true,
    projectilePaintSurface: impactSurface,
    weaponFireRate: `${Math.round(1 / SPLATTERSHOT.fireIntervalSeconds)}/s`,
    deterministicFanSpread: true,
    typedLevelTransforms: true,
    physics: projectileWorld.physicsKind,
    serverGameplayState: false
  }, null, 2));
} finally {
  worlds.forEach((world) => world.dispose());
  await roomB?.leave();
  await roomA?.leave();
}
