import assert from "node:assert/strict";
import { GameRuntime } from "../apps/client/src/game/GameRuntime.js";
import { TiledInkField } from "../packages/simulation/src/ink.js";
import { TOFU_TEST_LEVEL, createLevelWallSurfaces } from "../packages/simulation/src/level.js";
import { AnalyticPhysicsAdapter } from "../packages/simulation/src/physics.js";
import { createRapierPhysicsAdapter } from "../packages/simulation/src/rapier-physics.js";
import { SPLATTERSHOT, getWeaponDefinition, listWeaponDefinitions } from "../packages/simulation/src/weapons.js";
import { GameWorld } from "../packages/simulation/src/world.js";

let fixedSteps = 0;
let stateSends = 0;
let frameSeconds = 0;
const runtime = new GameRuntime({
  fixedStepSeconds: 1 / 60,
  stateSendIntervalSeconds: 1 / 20,
  onFixedStep: () => fixedSteps += 1,
  onStateSend: () => stateSends += 1,
  onFrame: (dt) => frameSeconds += dt
});
runtime.advance(1 / 30);
runtime.advance(1 / 30);
assert.equal(fixedSteps, 4, "fixed-step runtime lost simulation ticks");
assert.equal(stateSends, 1, "runtime did not schedule state transmission independently");
assert.ok(frameSeconds > 0.06, "runtime did not preserve render-frame delta");

assert.equal(getWeaponDefinition("splattershot"), SPLATTERSHOT);
assert.equal(listWeaponDefinitions().length, 1);
assert.equal(createLevelWallSurfaces(TOFU_TEST_LEVEL).length, TOFU_TEST_LEVEL.obstacles.length * 4 + 4);

const stamp = {
  id: "architecture-ink",
  team: 0 as const,
  surfaceId: "ground" as const,
  x: 1,
  y: 0,
  z: -2,
  radiusU: 1.2,
  radiusV: 0.8,
  rotation: 0.3
};
const ink = new TiledInkField(TOFU_TEST_LEVEL);
assert.equal(ink.teamAt(stamp.x, stamp.z), null, "new ink field must be neutral");
ink.paint(stamp, 7);
assert.equal(ink.teamAt(stamp.x, stamp.z), stamp.team);
const dirtyTiles = ink.takeDirtyTileSnapshots();
assert.ok(dirtyTiles.length > 0, "paint did not dirty any ownership tile");
const replicaInk = new TiledInkField(TOFU_TEST_LEVEL);
dirtyTiles.forEach((tile) => assert.equal(replicaInk.applyTileSnapshot(tile), true));
assert.equal(replicaInk.teamAt(stamp.x, stamp.z), stamp.team);
assert.deepEqual(replicaInk.tileHashes(), ink.tileHashes(), "tile hashes diverged after snapshot replication");
assert.equal(
  replicaInk.applyTileSnapshot({ ...dirtyTiles[0], hash: dirtyTiles[0].hash ^ 1 }),
  false,
  "tampered ink tile passed hash validation"
);

const world = new GameWorld(TOFU_TEST_LEVEL, new AnalyticPhysicsAdapter(TOFU_TEST_LEVEL));
const player = world.createPlayer("architecture-player", "Architecture", 0);
world.applyPaint([stamp]);
const shot = world.shoot(
  player.id,
  "architecture-shot",
  SPLATTERSHOT.id,
  { x: 0, y: 0.1, z: 1 },
  { x: 0, z: 1 },
  { x: 1, z: 0 },
  SPLATTERSHOT.paint.footEveryShots
);
assert.ok(shot && world.bullets.has(shot.bullet.id), "GameWorld did not own a spawned projectile");
assert.ok(shot.events.some((event) => event.kind === "paint"), "weapon definition did not drive foot paint");
world.step(player.id, {
  moveX: 0,
  moveZ: 1,
  jumpPressed: false,
  diving: false,
  groundTeam: world.ink.teamAt(player.x, player.z)
}, 1 / 60);
const snapshot = world.snapshot();
const restored = new GameWorld(TOFU_TEST_LEVEL, new AnalyticPhysicsAdapter(TOFU_TEST_LEVEL));
restored.restore(snapshot);
assert.equal(restored.tick, world.tick);
assert.deepEqual([...restored.players.values()], [...world.players.values()]);
assert.deepEqual([...restored.bullets.values()], [...world.bullets.values()]);
assert.deepEqual(restored.ink.tileHashes(), world.ink.tileHashes());
world.dispose();
restored.dispose();

const rapier = await createRapierPhysicsAdapter(TOFU_TEST_LEVEL);
const impact = rapier.castProjectile(
  { x: -6.5, y: 1, z: 0 },
  { x: -4.95, y: 1, z: 0 },
  0.2
);
assert.equal(impact?.impact.surfaceId, "obstacle-0-nx", "Rapier query selected the wrong painted wall");
assert.ok(Math.abs((impact?.impact.x ?? 0) + 5.6) < 0.001);
const mover = {
  ...player,
  x: -6.1,
  y: 0,
  z: 0,
  vx: 0,
  vy: 0,
  vz: 0
};
const movement = rapier.resolvePlayerMovement(mover, { x: 1, z: 0 }, { radius: 0.45, height: 1.3 });
assert.equal(movement.blockedX, true, "Rapier capsule passed through level geometry");
assert.ok(movement.x <= -6.05);
assert.equal(rapier.findWallContact({ ...mover, x: -6 })?.id, "obstacle-0-nx");
rapier.dispose();

console.log(JSON.stringify({
  ok: true,
  fixedSteps,
  dataDrivenLevel: TOFU_TEST_LEVEL.id,
  weapon: SPLATTERSHOT.id,
  replicatedInkTiles: dirtyTiles.length,
  worldSnapshotTick: snapshot.tick,
  physics: "rapier"
}, null, 2));
