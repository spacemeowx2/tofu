import { ColyseusSDK, type Room } from "@colyseus/sdk";
import { PROTOCOL_VERSION, ROOM_NAME, type BulletSnapshot, type PeerPacket, type RelayedPeerPacket } from "@tofu/protocol";
import {
  bulletHitsPlayer,
  createSplattershotPaintStamps,
  createPlayer,
  findWallContact,
  groundPointToCanvasUv,
  InkField,
  spawnBullet,
  SPLATTERSHOT_PROFILE,
  stepBullet,
  stepPlayer,
  wallPointToCanvasUv,
  WALL_SURFACES
} from "@tofu/simulation";

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

  const player = createPlayer(peerIdA, peerA.name, peerA.team as 0 | 1);
  const packet: PeerPacket = {
    protocolVersion: PROTOCOL_VERSION,
    kind: "player_state",
    peerId: peerIdA,
    sequence: 1,
    simulationTick: 10,
    player
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
  if (!reconnectedPeer || reconnectedPeer.team !== originalTeam) throw new Error("reconnect changed the peer's original team");

  const walker = createPlayer("walk", "walk", 0);
  const swimmer = createPlayer("swim", "swim", 0);
  const ink = new InkField();
  if (ink.teamAt(swimmer.x, swimmer.z) !== null) throw new Error("ink field was not neutral at match start");
  ink.paint({ id: "own-ground", team: 0, surfaceId: "ground", x: swimmer.x, y: 0, z: swimmer.z, radiusU: 10, radiusV: 10, rotation: 0 });
  for (let tick = 0; tick < 60; tick += 1) {
    stepPlayer(walker, { moveX: 0, moveZ: 1, jumpPressed: false, diving: false, groundTeam: ink.teamAt(walker.x, walker.z) }, 1 / 60);
    stepPlayer(swimmer, { moveX: 0, moveZ: 1, jumpPressed: false, diving: true, groundTeam: ink.teamAt(swimmer.x, swimmer.z) }, 1 / 60);
  }
  if (swimmer.z - walker.z < 1) throw new Error("diving on own-color ground did not increase speed");

  const neutralSwimmer = createPlayer("neutral", "neutral", 0);
  neutralSwimmer.x = 7;
  const neutralWalker = { ...neutralSwimmer, id: "neutral-walk" };
  for (let tick = 0; tick < 60; tick += 1) {
    stepPlayer(neutralSwimmer, { moveX: 0, moveZ: 1, jumpPressed: false, diving: true, groundTeam: null }, 1 / 60);
    stepPlayer(neutralWalker, { moveX: 0, moveZ: 1, jumpPressed: false, diving: false, groundTeam: null }, 1 / 60);
  }
  if (Math.abs(neutralSwimmer.z - neutralWalker.z) > 0.05) throw new Error("neutral ground incorrectly granted dive speed");

  const jumper = createPlayer("jump", "jump", 0);
  stepPlayer(jumper, { moveX: 0, moveZ: 0, jumpPressed: true, diving: false, groundTeam: null }, 1 / 60);
  if (jumper.y <= 0 || jumper.vy <= 0) throw new Error("jump was not simulated locally");

  const climber = createPlayer("climber", "climber", 0);
  climber.x = -5.92;
  climber.z = 0;
  ink.paint({ id: "own-wall", team: 0, surfaceId: "obstacle-0-nx", x: -5.6, y: 0.5, z: 0, radiusU: 1.25, radiusV: 1.25, rotation: 0 });
  const wallContact = findWallContact(climber);
  if (!wallContact) throw new Error("painted wall contact was not detected");
  stepPlayer(climber, {
    moveX: 1,
    moveZ: 0,
    jumpPressed: false,
    diving: true,
    groundTeam: null,
    wallContact: { ...wallContact, team: ink.teamAtWall(wallContact.id, wallContact.x, wallContact.y, wallContact.z) }
  }, 1 / 60);
  if (!climber.wallAttached || climber.y <= 0) throw new Error("Shift did not attach and climb on own-color wall ink");

  const arcProbe: BulletSnapshot = {
    id: "arc", ownerId: peerIdA, team: 0, x: 0, y: 0.82, z: 0, dx: 0.2, dy: 0.25, dz: 0.2, age: 0,
    distanceTraveled: 0, paintTrailIndex: 0, seed: 7, weaponId: "splattershot"
  };
  const initialVerticalVelocity = arcProbe.dy;
  let arcImpact: ReturnType<typeof stepBullet>["paintImpact"];
  let trailPaintCount = 0;
  for (let tick = 0; tick < 180 && !arcImpact; tick += 1) {
    const result = stepBullet(arcProbe, 1 / 60);
    trailPaintCount += result.trailPaintImpacts.length;
    arcImpact = result.paintImpact;
  }
  if (!arcImpact || arcProbe.dy >= initialVerticalVelocity) throw new Error("projectile did not follow a gravity arc into a paintable surface");
  if (trailPaintCount === 0) throw new Error("Splattershot projectile did not shed paint along its flight path");

  const spreadPlayer = createPlayer("spread", "spread", 0);
  const spreadShots = Array.from({ length: 24 }, (_, index) => spawnBullet(
    `spread:${index}`,
    spreadPlayer,
    { x: 0, y: 0, z: 1 },
    { x: 0, z: 1 },
    { x: 1, z: 0 }
  ));
  if (!spreadShots.some((bullet) => bullet.dx < 0) || !spreadShots.some((bullet) => bullet.dx > 0)) {
    throw new Error("Splattershot spread did not form a deterministic fan");
  }
  const upwardShot = spawnBullet(
    "aim-up", spreadPlayer, { x: 0, y: 0.5, z: 0.866 }, { x: 0, z: 1 }, { x: 1, z: 0 }
  );
  const downwardShot = spawnBullet(
    "aim-down", spreadPlayer, { x: 0, y: -0.5, z: 0.866 }, { x: 0, z: 1 }, { x: 1, z: 0 }
  );
  if (upwardShot.dy <= 0.3 || downwardShot.dy >= -0.3) {
    throw new Error("Splattershot discarded the vertical component of the aim direction");
  }
  const falloffProbe: BulletSnapshot = {
    id: "falloff", ownerId: peerIdA, team: 0, x: 0, y: 5, z: 0, dx: 1, dy: 0, dz: 0, age: 0,
    distanceTraveled: SPLATTERSHOT_PROFILE.paintRange + 0.01, paintTrailIndex: 6, seed: 13, weaponId: "splattershot"
  };
  stepBullet(falloffProbe, 1 / 60);
  if (falloffProbe.x >= 0.12 || falloffProbe.dy >= 0) {
    throw new Error("Splattershot did not slow and fall after its effective range");
  }
  const splatMarks = createSplattershotPaintStamps({
    id: "splat-test", team: 0, surfaceId: "ground", x: 0, y: 0, z: 0,
    directionX: 0.3, directionY: -0.2, directionZ: 1, seed: 42, kind: "impact"
  });
  if (splatMarks.length !== 6 || new Set(splatMarks.map((stamp) => stamp.radiusU.toFixed(3))).size < 3) {
    throw new Error("Splattershot impact did not generate an irregular main splat and satellites");
  }

  const groundNorthWest = groundPointToCanvasUv({ x: -12, z: 12 });
  const groundSouthEast = groundPointToCanvasUv({ x: 12, z: -12 });
  if (groundNorthWest.u !== 0 || groundNorthWest.v !== 0 || groundSouthEast.u !== 1 || groundSouthEast.v !== 1) {
    throw new Error("ground world-to-canvas transform is mirrored");
  }
  const xWall = WALL_SURFACES.find((surface) => surface.id === "obstacle-0-nx")!;
  const oppositeXWall = WALL_SURFACES.find((surface) => surface.id === "obstacle-0-px")!;
  const zWall = WALL_SURFACES.find((surface) => surface.id === "obstacle-0-nz")!;
  const oppositeZWall = WALL_SURFACES.find((surface) => surface.id === "obstacle-0-pz")!;
  const xWallTopStart = wallPointToCanvasUv(xWall, { x: xWall.coordinate, y: xWall.height, z: xWall.minAlong });
  const oppositeXWallStart = wallPointToCanvasUv(oppositeXWall, { x: oppositeXWall.coordinate, y: 0, z: oppositeXWall.minAlong });
  const zWallBottomStart = wallPointToCanvasUv(zWall, { x: zWall.minAlong, y: 0, z: zWall.coordinate });
  const oppositeZWallStart = wallPointToCanvasUv(oppositeZWall, { x: oppositeZWall.minAlong, y: 0, z: oppositeZWall.coordinate });
  if (
    xWallTopStart.u !== 1 || xWallTopStart.v !== 0 ||
    oppositeXWallStart.u !== 0 || oppositeXWallStart.v !== 1 ||
    zWallBottomStart.u !== 0 || zWallBottomStart.v !== 1 ||
    oppositeZWallStart.u !== 1 || oppositeZWallStart.v !== 1
  ) {
    throw new Error("wall world-to-canvas transform does not match plane orientation");
  }

  const wallProbe: BulletSnapshot = {
    id: "wall-probe",
    ownerId: peerIdA,
    team: 0 as const,
    x: -6.5,
    y: 1,
    z: 0,
    dx: 1,
    dy: 0,
    dz: 0,
    age: 0,
    distanceTraveled: 0,
    paintTrailIndex: 0,
    seed: 9,
    weaponId: "splattershot"
  };
  const wallProbeResult = stepBullet(wallProbe, 0.1);
  if (wallProbeResult.paintImpact?.surfaceId !== "obstacle-0-nx" || Math.abs(wallProbeResult.paintImpact.x + 5.6) > 0.001) {
    throw new Error("fast projectile did not paint its continuous wall intersection");
  }

  const capsuleTarget = createPlayer("target", "target", 1);
  const capProbe: BulletSnapshot = {
    id: "probe",
    ownerId: "walk",
    team: 0 as const,
    x: capsuleTarget.x,
    y: 1.4,
    z: capsuleTarget.z,
    dx: 0,
    dy: 0,
    dz: 1,
    age: 0,
    distanceTraveled: 0,
    paintTrailIndex: 0,
    seed: 11,
    weaponId: "splattershot"
  };
  if (!bulletHitsPlayer(capProbe, capsuleTarget)) throw new Error("rounded capsule cap did not register a hit");

  console.log(JSON.stringify({
    ok: true,
    mode: "peer-owned simulation over central relay",
    roomId: roomA.roomId,
    teams: [peerA.team, peerB.team],
    reconnectPreservedTeam: true,
    relayedKind: received?.packet.kind ?? packet.kind,
    ownInkDiveGain: Number((swimmer.z - walker.z).toFixed(2)),
    jumpHeightAfterFirstTick: Number(jumper.y.toFixed(3)),
    wallAttachAndClimb: true,
    projectilePaintSurface: arcImpact.surfaceId,
    splattershotFireRate: `${Math.round(1 / SPLATTERSHOT_PROFILE.fireIntervalSeconds)}/s`,
    splattershotFanSpread: true,
    splattershotAimPitch: true,
    splattershotRangeFalloff: true,
    splattershotTrailDrops: trailPaintCount,
    irregularImpactMarks: splatMarks.length,
    continuousWallImpact: wallProbeResult.paintImpact.surfaceId,
    typedCanvasTransforms: true,
    serverGameplayState: false
  }, null, 2));
} finally {
  await roomB?.leave();
  await roomA?.leave();
}
