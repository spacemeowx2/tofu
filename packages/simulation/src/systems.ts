import {
  PLAYER_COLLIDER_HEIGHT,
  PLAYER_DIVE_COLLIDER_HEIGHT,
  PLAYER_DIVE_RADIUS,
  PLAYER_MAX_HP,
  PLAYER_RADIUS,
  type BulletSnapshot,
  type PaintSurfaceId,
  type PaintStamp,
  type PlayerSnapshot,
  type TeamId,
  type WeaponId
} from "@tofu/protocol";
import { getTeamSpawn, type LevelDefinition, type WallSurface } from "./level.js";
import { playerCollider, type PhysicsAdapter, type WallContact } from "./physics.js";
import type { WeaponCatalog, WeaponDefinition } from "./weapons.js";

export type PlayerInput = {
  moveX: number;
  moveZ: number;
  jumpPressed: boolean;
  diving: boolean;
  groundTeam: TeamId | null;
  wallContact?: WallContact & { team: TeamId | null };
};

export type PaintSplatKind = "trail" | "impact" | "foot";

type PaintSplatInput = {
  id: string;
  team: TeamId;
  surfaceId: PaintSurfaceId;
  x: number;
  y: number;
  z: number;
  directionX: number;
  directionY: number;
  directionZ: number;
  seed: number;
  kind: PaintSplatKind;
};

export function createPlayerState(
  id: string,
  name: string,
  team: TeamId,
  weaponId: WeaponId,
  teamSlot: number,
  level: LevelDefinition
): PlayerSnapshot {
  const spawn = getTeamSpawn(level, team, teamSlot);
  return {
    id,
    name,
    team,
    weaponId,
    x: spawn.x,
    y: 0,
    z: spawn.z,
    vx: 0,
    vy: 0,
    vz: 0,
    facingX: team === 0 ? 1 : -1,
    facingZ: 0,
    hp: PLAYER_MAX_HP,
    alive: true,
    diving: false,
    wallAttached: false,
    wallSurfaceId: ""
  };
}

export function stepPlayerState(
  player: PlayerSnapshot,
  input: PlayerInput,
  dt: number,
  physics: PhysicsAdapter
) {
  if (!player.alive) return;
  const wall = input.wallContact;
  if (input.diving && wall?.team === player.team && player.y < wall.height) {
    player.diving = true;
    player.wallAttached = true;
    player.wallSurfaceId = wall.id;
    player.vx = 0;
    player.vy = 0;
    player.vz = 0;
    const climbInput = Math.max(0, -(input.moveX * wall.normalX + input.moveZ * wall.normalZ));
    player.y = Math.min(wall.height, player.y + climbInput * 4.2 * dt);
    player.x = wall.x + wall.normalX * PLAYER_DIVE_RADIUS;
    player.z = wall.z + wall.normalZ * PLAYER_DIVE_RADIUS;
    return;
  }

  player.wallAttached = false;
  player.wallSurfaceId = "";
  const grounded = player.y <= 0.0001;
  if (input.jumpPressed && grounded && !input.diving) {
    player.vy = 7.2;
    player.diving = false;
  } else {
    player.diving = input.diving && grounded;
  }

  const maxSpeed = player.diving && input.groundTeam === player.team ? 7.4 : 5.5;
  const hasInput = Math.hypot(input.moveX, input.moveZ) > 0.01;
  const acceleration = hasInput ? 30 : 42;
  player.vx = approach(player.vx, input.moveX * maxSpeed, acceleration * dt);
  player.vz = approach(player.vz, input.moveZ * maxSpeed, acceleration * dt);

  const speed = Math.hypot(player.vx, player.vz);
  if (speed > 0.05) {
    player.facingX = player.vx / speed;
    player.facingZ = player.vz / speed;
  }

  player.vy -= 20 * dt;
  player.y += player.vy * dt;
  if (player.y <= 0) {
    player.y = 0;
    player.vy = 0;
  }

  const movement = physics.resolvePlayerMovement(
    player,
    { x: player.vx * dt, z: player.vz * dt },
    playerCollider(player)
  );
  player.x = movement.x;
  player.z = movement.z;
  if (movement.blockedX) player.vx = 0;
  if (movement.blockedZ) player.vz = 0;
}

export function createBulletState(
  id: string,
  player: PlayerSnapshot,
  direction: { x: number; y: number; z: number },
  forward: { x: number; z: number },
  right: { x: number; z: number },
  weapon: WeaponDefinition
): BulletSnapshot {
  const seed = hashString(id);
  const spreadRadians = (player.y > 0.05 ? weapon.spread.airDegrees : weapon.spread.groundDegrees) * Math.PI / 180;
  const spreadRadius = Math.sqrt(random01(seed)) * Math.tan(spreadRadians);
  const spreadAngle = random01(seed ^ 0x9e3779b9) * Math.PI * 2;
  const spreadSide = Math.cos(spreadAngle) * spreadRadius;
  const spreadUp = Math.sin(spreadAngle) * spreadRadius;
  const spreadDirection = normalize3({
    x: direction.x + right.x * spreadSide,
    y: direction.y + spreadUp,
    z: direction.z + right.z * spreadSide
  });
  return {
    id,
    ownerId: player.id,
    team: player.team,
    x: player.x + forward.x * weapon.muzzle.forward + right.x * weapon.muzzle.side,
    y: player.y + weapon.muzzle.height,
    z: player.z + forward.z * weapon.muzzle.forward + right.z * weapon.muzzle.side,
    dx: spreadDirection.x,
    dy: spreadDirection.y,
    dz: spreadDirection.z,
    age: 0,
    distanceTraveled: 0,
    paintTrailIndex: 0,
    seed,
    weaponId: weapon.id
  };
}

export function stepBulletState(
  bullet: BulletSnapshot,
  dt: number,
  physics: PhysicsAdapter,
  level: LevelDefinition,
  weapon: WeaponDefinition
) {
  const previous = { x: bullet.x, y: bullet.y, z: bullet.z };
  bullet.age += dt;
  const flightSpeed = bullet.distanceTraveled < weapon.projectile.paintRange
    ? weapon.projectile.speed
    : weapon.projectile.speed * weapon.projectile.falloffSpeedMultiplier;
  bullet.x += bullet.dx * flightSpeed * dt;
  bullet.y += bullet.dy * flightSpeed * dt;
  bullet.z += bullet.dz * flightSpeed * dt;
  bullet.dy -= weapon.projectile.gravity / flightSpeed * dt;
  const segmentDistance = Math.hypot(bullet.x - previous.x, bullet.y - previous.y, bullet.z - previous.z);
  const groundAmount = previous.y > weapon.projectile.radius && bullet.y <= weapon.projectile.radius
    ? (previous.y - weapon.projectile.radius) / (previous.y - bullet.y)
    : undefined;
  const wallImpact = physics.castProjectile(previous, bullet, weapon.projectile.radius);
  const groundWins = groundAmount !== undefined && (!wallImpact || groundAmount <= wallImpact.amount);
  const travelAmount = (groundWins ? groundAmount : wallImpact?.amount) ?? 1;
  const previousDistance = bullet.distanceTraveled;
  const nextDistance = previousDistance + segmentDistance * travelAmount;
  const trailPaintImpacts: Array<{ surfaceId: "ground"; x: number; y: 0; z: number }> = [];
  const pattern = weapon.paint.trailPatterns[bullet.seed % weapon.paint.trailPatterns.length];
  while (bullet.paintTrailIndex < pattern.length) {
    const distance = pattern[bullet.paintTrailIndex];
    if (distance > nextDistance) break;
    const amount = segmentDistance > 0
      ? Math.max(0, Math.min(travelAmount, (distance - previousDistance) / segmentDistance))
      : 0;
    const x = previous.x + (bullet.x - previous.x) * amount;
    const z = previous.z + (bullet.z - previous.z) * amount;
    if (Math.abs(x) <= level.halfSize && Math.abs(z) <= level.halfSize) {
      trailPaintImpacts.push({ surfaceId: "ground", x, y: 0, z });
    }
    bullet.paintTrailIndex += 1;
  }
  bullet.distanceTraveled = nextDistance;

  if (groundWins) {
    bullet.x = previous.x + (bullet.x - previous.x) * groundAmount;
    bullet.y = weapon.projectile.radius;
    bullet.z = previous.z + (bullet.z - previous.z) * groundAmount;
    return {
      alive: false,
      trailPaintImpacts,
      paintImpact: { surfaceId: "ground" as const, x: bullet.x, y: 0, z: bullet.z }
    };
  }
  if (wallImpact) {
    bullet.x = previous.x + (bullet.x - previous.x) * wallImpact.amount;
    bullet.y = previous.y + (bullet.y - previous.y) * wallImpact.amount;
    bullet.z = previous.z + (bullet.z - previous.z) * wallImpact.amount;
    return { alive: false, trailPaintImpacts, paintImpact: wallImpact.impact };
  }
  return {
    alive: !(
      bullet.age >= weapon.projectile.lifetime ||
      bullet.y > 8 ||
      Math.abs(bullet.x) > level.halfSize + weapon.projectile.radius ||
      Math.abs(bullet.z) > level.halfSize + weapon.projectile.radius
    ),
    trailPaintImpacts
  };
}

export function createPaintStamps(
  input: PaintSplatInput,
  weapon: WeaponDefinition,
  wallSurfaces: readonly WallSurface[]
): PaintStamp[] {
  const surface = input.surfaceId === "ground"
    ? undefined
    : wallSurfaces.find((candidate) => candidate.id === input.surfaceId);
  if (input.surfaceId !== "ground" && !surface) return [];
  const directionU = input.surfaceId === "ground"
    ? input.directionX
    : surface!.axis === "x" ? input.directionZ : input.directionX;
  const directionV = input.surfaceId === "ground" ? input.directionZ : input.directionY;
  const baseRotation = Math.atan2(directionV, directionU);
  const definition = weapon.paint.splats[input.kind];
  const marks: PaintStamp[] = [];

  for (let index = 0; index <= definition.satelliteCount; index += 1) {
    const markSeed = input.seed ^ Math.imul(index + 1, 0x45d9f3b);
    const isMain = index === 0;
    const forward = isMain ? 0 : interpolate(definition.forwardRange, random01(markSeed ^ 0x27d4eb2d));
    const lateral = isMain ? 0 : randomSigned(markSeed) * interpolate(definition.lateralRange, random01(markSeed ^ 0x165667b1));
    const cos = Math.cos(baseRotation);
    const sin = Math.sin(baseRotation);
    const offsetU = forward * cos - lateral * sin;
    const offsetV = forward * sin + lateral * cos;
    const radiusScale = isMain ? 1 : interpolate(definition.radiusScaleRange, random01(markSeed ^ 0x85ebca6b));
    let { x, y, z } = input;
    if (input.surfaceId === "ground") {
      x += offsetU;
      z += offsetV;
    } else if (surface!.axis === "x") {
      z += offsetU;
      y += offsetV;
    } else {
      x += offsetU;
      y += offsetV;
    }
    marks.push({
      id: `${input.id}:${index}`,
      team: input.team,
      surfaceId: input.surfaceId,
      x,
      y,
      z,
      radiusU: definition.mainRadius[0] * radiusScale,
      radiusV: definition.mainRadius[1] * radiusScale * (isMain ? 1 : 0.88 + random01(markSeed ^ 0xc2b2ae35) * 0.34),
      rotation: baseRotation + randomSigned(markSeed ^ 0x9e3779b9) * (isMain ? 0.16 : 0.7)
    } as PaintStamp);
  }
  return marks;
}

export function bulletHitsPlayer(
  bullet: BulletSnapshot,
  player: PlayerSnapshot,
  weapons: WeaponCatalog
) {
  const radius = player.diving ? PLAYER_DIVE_RADIUS : PLAYER_RADIUS;
  const height = player.diving ? PLAYER_DIVE_COLLIDER_HEIGHT : PLAYER_COLLIDER_HEIGHT;
  const nearestY = Math.max(player.y + radius, Math.min(player.y + height - radius, bullet.y));
  return Math.hypot(bullet.x - player.x, bullet.y - nearestY, bullet.z - player.z) <=
    radius + weapons.get(bullet.weaponId).projectile.radius;
}

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function random01(seed: number) {
  let value = seed >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value >>> 0) / 0x1_0000_0000;
}

function randomSigned(seed: number) {
  return random01(seed) * 2 - 1;
}

function normalize3(value: { x: number; y: number; z: number }) {
  const length = Math.hypot(value.x, value.y, value.z) || 1;
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

function approach(current: number, target: number, maxDelta: number) {
  if (current < target) return Math.min(current + maxDelta, target);
  if (current > target) return Math.max(current - maxDelta, target);
  return target;
}

function interpolate(range: readonly [number, number], amount: number) {
  return range[0] + (range[1] - range[0]) * amount;
}
