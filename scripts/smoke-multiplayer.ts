import { ColyseusSDK, type Room } from "@colyseus/sdk";
import { BULLET_DAMAGE, PLAYER_MAX_HP, ROOM_NAME } from "@tofu/protocol";

type Player = { x: number; z: number; hp: number; name: string };
type PlayerMap = { get(id: string): Player | undefined };
type Bullet = { ownerId: string; dx: number; dy: number; dz: number };
type BulletMap = { forEach(callback: (bullet: Bullet) => void): void };
type State = { players: PlayerMap; bullets: BulletMap };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const clientA = new ColyseusSDK("ws://localhost:2567");
const clientB = new ColyseusSDK("ws://localhost:2567");
let roomA: Room | undefined;
let roomB: Room | undefined;

try {
  roomA = await clientA.create(ROOM_NAME, { name: "Smoke-A" });
  roomA.onMessage("game_event", () => {});
  roomB = await clientB.joinById(roomA.roomId, { name: "Smoke-B" });
  roomB.onMessage("game_event", () => {});
  await sleep(250);

  roomA.send("move", { x: 1, z: 1, sequence: 1 });
  roomB.send("move", { x: -1, z: -1, sequence: 1 });
  await sleep(1650);
  roomA.send("move", { x: 0, z: 0, sequence: 2 });
  roomB.send("move", { x: 0, z: 0, sequence: 2 });
  await sleep(180);

  const state = roomA.state as State;
  const a = state.players.get(roomA.sessionId);
  const b = state.players.get(roomB.sessionId);
  if (!a || !b) throw new Error("players were not synchronized into the same room");

  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz);

  const probeDirection = { dx: 0.36, dy: 0.8, dz: 0.48 };
  roomA.send("shoot", { ...probeDirection, sequence: 1 });
  let probe: Bullet | undefined;
  const probeDeadline = Date.now() + 500;
  while (!probe && Date.now() < probeDeadline) {
    state.bullets.forEach((bullet) => { if (bullet.ownerId === roomA?.sessionId) probe = bullet; });
    if (!probe) await sleep(20);
  }
  if (!probe || Math.abs(probe.dx - probeDirection.dx) > 0.01 || Math.abs(probe.dy - probeDirection.dy) > 0.01 || Math.abs(probe.dz - probeDirection.dz) > 0.01) {
    throw new Error(`3D aim direction was not preserved: ${JSON.stringify(probe)}`);
  }
  await sleep(900);

  roomA.send("shoot", { dx: dx / length, dy: 0, dz: dz / length, sequence: 2 });

  const deadline = Date.now() + 2000;
  while (b.hp === PLAYER_MAX_HP && Date.now() < deadline) await sleep(50);
  if (b.hp !== PLAYER_MAX_HP - BULLET_DAMAGE) {
    throw new Error(`expected ${PLAYER_MAX_HP - BULLET_DAMAGE} HP after hit, received ${b.hp}`);
  }

  console.log(JSON.stringify({
    ok: true,
    roomId: roomA.roomId,
    players: 2,
    shooter: { x: Number(a.x.toFixed(2)), z: Number(a.z.toFixed(2)) },
    target: { x: Number(b.x.toFixed(2)), z: Number(b.z.toFixed(2)), hp: b.hp },
    aimProbe: probeDirection,
    damage: BULLET_DAMAGE
  }, null, 2));
} finally {
  await roomB?.leave();
  await roomA?.leave();
}
