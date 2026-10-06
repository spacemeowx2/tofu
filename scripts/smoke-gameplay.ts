import assert from "node:assert/strict";
import { GameWorld } from "../packages/simulation/src/world.js";
import { COMPACT_TEST_LEVEL, type LevelDefinition } from "../packages/simulation/src/level.js";
import { createRapierPhysicsAdapter } from "../packages/simulation/src/rapier-physics.js";
import { bulletHitsPlayer, createBulletState } from "../packages/simulation/src/systems.js";
import { DEFAULT_WEAPONS, SPLATTERSHOT } from "../packages/simulation/src/weapons.js";

const worlds: GameWorld[] = [];
const dt = 1 / 60;
const idle = { moveX: 0, moveZ: 0, jumpPressed: false, diving: false };
async function makeWorld(level = COMPACT_TEST_LEVEL) {
  const world = new GameWorld(level, await createRapierPhysicsAdapter(level));
  worlds.push(world);
  return world;
}
const flat: LevelDefinition = { ...COMPACT_TEST_LEVEL, id: "gameplay-flat", halfSize: 12, obstacles: [], targets: [] };

try {
  const world = await makeWorld();
  const player = world.createPlayer("platform", "Platform", 0, SPLATTERSHOT.id);
  world.upsertPlayer({ ...player, x: 0, y: 4, z: 0, grounded: false });
  for (let tick = 0; tick < 180; tick++) world.step([{ playerId: player.id, input: idle }], dt);
  assert.ok(Math.abs(player.y - 1.6) < 0.05 && player.grounded, "Rapier did not land the capsule on a platform");
  world.applyPaint([{
    id: "top-paint", team: 0, kind: "impact", surfaceId: "top-0", originX: 0, originY: 1.6, originZ: 0,
    x: 0, y: 1.6, z: 0, radiusU: 0.7, radiusV: 0.7, rotation: 0
  }]);
  assert.equal(world.ink.teamAt(0, 0, player.y), 0, "platform ink was not used for swimming");
  assert.equal(world.ink.teamAt(0, 0, 0), null, "painting a roof painted the ground beneath it");
  assert.ok(world.turfCoverage()[0] > 0, "paintable roofs did not contribute to turf coverage");
  world.step([{ playerId: player.id, input: { ...idle, jumpPressed: true } }], dt);
  assert.ok(player.vy > 0 && player.y > 1.65, "jumping from a platform did not work");

  const tank = await makeWorld(flat);
  const tankPlayer = tank.createPlayer("tank", "Tank", 0, SPLATTERSHOT.id);
  let shots = 0;
  for (let i = 1; i <= 120; i++) {
    if (tank.shoot(tankPlayer.id, `tank:${i}`, { x: 0, y: 0, z: 1 }, { x: 0, z: 1 }, { x: 1, z: 0 }, i)) shots++;
  }
  assert.equal(shots, Math.floor(100 / SPLATTERSHOT.inkCost), "empty tank did not stop shooting");
  const emptyInput = { ...idle, fire: { direction: { x: 0, y: 0, z: 1 }, forward: { x: 0, z: 1 }, right: { x: 1, z: 0 } } };
  for (let tick = 0; tick < 15; tick++) tank.step([{ playerId: tankPlayer.id, input: emptyInput }], dt);
  assert.equal(tank.snapshot().playerRuntime[0].bulletSequence, 0, "empty fire advanced the shot sequence");
  const emptyRestore = await makeWorld(flat);
  emptyRestore.restore(tank.snapshot());
  tank.applyPaint([{
    id: "refill-puddle", team: 0, kind: "foot", surfaceId: "ground", originX: tankPlayer.x, originY: 0, originZ: tankPlayer.z,
    x: tankPlayer.x, y: 0, z: tankPlayer.z, radiusU: 1, radiusV: 1, rotation: 0
  }]);
  for (let tick = 0; tick < 120; tick++) tank.step([{ playerId: tankPlayer.id, input: { ...idle, diving: true } }], dt);
  assert.ok(tankPlayer.ink > 49 && tankPlayer.ink < 62, "own-ink swim refill ignored the firing cooldown or recovery rate");

  const flow = await makeWorld(flat);
  const flowPlayer = flow.createPlayer("flow", "Flow", 0, SPLATTERSHOT.id);
  const probe = createBulletState("flow-probe", flowPlayer, { x: 0, y: -1, z: 0.6 }, { x: 0, z: 1 }, { x: 1, z: 0 }, SPLATTERSHOT);
  flow.addBullet({ ...probe, x: 0, y: 0.22, z: 0, dx: 0, dy: -1, dz: 0.6 });
  const impact = flow.step([{ playerId: flowPlayer.id, input: idle }], dt).find((event) => event.kind === "paint" && event.stamps[0]?.kind === "impact");
  assert.ok(impact?.kind === "paint", "real ground impact did not paint");
  const earlyRadius = impact.stamps[0].radiusU;
  const earlyCoverage = flow.turfCoverage()[0];
  for (let tick = 0; tick < 4; tick++) flow.step([{ playerId: flowPlayer.id, input: idle }], dt);
  const restored = await makeWorld(flat);
  restored.restore(flow.snapshot());
  let lastRadius = 0;
  for (let tick = 0; tick < 14; tick++) {
    for (const event of flow.step([{ playerId: flowPlayer.id, input: idle }], dt)) if (event.kind === "paint" && event.stamps[0].kind === "flow") lastRadius = event.stamps[0].radiusU;
    restored.step([{ playerId: flowPlayer.id, input: idle }], dt);
  }
  assert.ok(lastRadius > earlyRadius * 2 && flow.turfCoverage()[0] > earlyCoverage, "ink did not spread over time");
  assert.deepEqual(flow.inkHashes(), restored.inkHashes(), "snapshot/restore changed ongoing ink flow");
  assert.equal(flow.snapshot().inkFlows.length, 0, "settled ink retained its flow simulation");

  const drops = await makeWorld(flat);
  const dropPlayer = drops.createPlayer("drops", "Drops", 0, SPLATTERSHOT.id);
  drops.shoot(dropPlayer.id, "drops:1", { x: 0, y: 0.25, z: 1 }, { x: 0, z: 1 }, { x: 1, z: 0 }, 1);
  const initialEvents = Array.from({ length: 5 }, () => drops.step([{ playerId: dropPlayer.id, input: idle }], dt)).flat();
  assert.ok([...drops.bullets.values()].some((bullet) => bullet.kind === "droplet"), "shot did not shed physical paint droplets");
  assert.ok(!initialEvents.some((event) => event.kind === "paint"), "airborne droplets painted the floor before touching it");

  const targets = await makeWorld({ ...flat, targets: [{ id: "dummy", x: 0, y: 0, z: 3 }] });
  const shooter = targets.createPlayer("shooter", "Shooter", 0, SPLATTERSHOT.id);
  targets.upsertPlayer({ ...shooter, x: 0, z: 0 });
  let hits = 0;
  for (let shot = 1; shot <= 3; shot++) {
    targets.shoot(shooter.id, `target:${shot}`, { x: 0, y: 0, z: 1 }, { x: 0, z: 1 }, { x: 1, z: 0 }, shot);
    for (let tick = 0; tick < 15; tick++) hits += targets.step([{ playerId: shooter.id, input: idle }], dt).filter((event) => event.kind === "target_hit").length;
  }
  assert.equal(hits, 3, "training target did not register three real projectile hits");
  assert.equal(targets.targets.get("dummy")?.hp, 0);
  for (let tick = 0; tick < 121; tick++) targets.step([{ playerId: shooter.id, input: idle }], dt);
  assert.equal(targets.targets.get("dummy")?.hp, 100, "training target did not recover");
  const fastBullet = { ...probe, x: 3, y: 0.7, z: 0 };
  assert.ok(bulletHitsPlayer(fastBullet, { x: 0, y: 0, z: 0, diving: false }, DEFAULT_WEAPONS, { x: -3, y: 0.7, z: 0 }), "swept capsule hit missed a fast projectile");
  assert.equal(world.isValidPlayerSnapshot({ ...player, ink: NaN }), false);
  assert.equal(world.isValidBulletSnapshot({ ...probe, dx: Infinity }), false);
  console.log(JSON.stringify({ ok: true, platformLanding: true, roofPaint: true, tankAndRefill: true, directionalTimedFlow: true, flowSnapshot: true, physicalDroplets: true, trainingTargets: true, sweptCapsuleHit: true }));
} finally {
  worlds.forEach((world) => world.dispose());
}
