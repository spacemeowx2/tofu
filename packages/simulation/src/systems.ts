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
  fire?: {
    direction: { x: number; y: number; z: number };
    forward: { x: number; z: number };
    right: { x: number; z: number };
  };
};

export type ResolvedPlayerInput = PlayerInput & {
  groundTeam: TeamId | null;
  wallContact?: WallContact & { team: TeamId | null };
};

export type PaintSplatKind = Exclude<PaintStamp["kind"], "flow">;

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
    facingX: -spawn.x / (Math.hypot(spawn.x, spawn.z) || 1),
    facingZ: -spawn.z / (Math.hypot(spawn.x, spawn.z) || 1),
    hp: PLAYER_MAX_HP,
    ink: 100,
    aimPitch: 0,
    grounded: true,
    alive: true,
    diving: false,
    wallAttached: false,
    wallSurfaceId: ""
  };
}

export function stepPlayerState(
  player: PlayerSnapshot,
  input: ResolvedPlayerInput,
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
    player.y = Math.min(wall.height + 0.04, player.y + climbInput * 4.2 * dt);
    player.x = wall.x + wall.normalX * PLAYER_DIVE_RADIUS;
    player.z = wall.z + wall.normalZ * PLAYER_DIVE_RADIUS;
    if (player.y >= wall.height) {
      player.x -= wall.normalX * (PLAYER_DIVE_RADIUS + 0.15);
      player.z -= wall.normalZ * (PLAYER_DIVE_RADIUS + 0.15);
      player.wallAttached = false;
    }
    return;
  }

  player.wallAttached = false;
  player.wallSurfaceId = "";
  const grounded = player.grounded;
  if (input.jumpPressed && grounded) {
    player.vy = 7.2;
    player.diving = false;
  } else {
    player.diving = input.diving && grounded;
  }

  const ownInk = input.groundTeam === player.team;
  const enemyInk = input.groundTeam !== null && !ownInk;
  const maxSpeed = player.diving ? ownInk ? 7.4 : 2.1 : enemyInk && grounded ? 2.6 : input.fire ? 3.8 : 5.5;
  const hasInput = Math.hypot(input.moveX, input.moveZ) > 0.01;
  const acceleration = hasInput ? 30 : 42;
  player.vx = approach(player.vx, input.moveX * maxSpeed, acceleration * dt);
  player.vz = approach(player.vz, input.moveZ * maxSpeed, acceleration * dt);

  const speed = Math.hypot(player.vx, player.vz);
  if (speed > 0.05) {
    player.facingX = player.vx / speed;
    player.facingZ = player.vz / speed;
  }
  if (input.fire && !player.diving) {
    player.facingX = input.fire.forward.x;
    player.facingZ = input.fire.forward.z;
    player.aimPitch = Math.asin(Math.max(-1, Math.min(1, input.fire.direction.y)));
  }

  player.vy -= 20 * dt;
  const movement = physics.resolvePlayerMovement(
    player,
    { x: player.vx * dt, y: player.vy * dt, z: player.vz * dt },
    playerCollider(player)
  );
  player.x = movement.x;
  player.y = movement.y;
  player.z = movement.z;
  player.grounded = movement.grounded;
  if (movement.blockedY) player.vy = 0;
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
    kind: "shot",
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
  const flightSpeed = bullet.kind === "droplet" ? 6 : bullet.distanceTraveled < weapon.projectile.paintRange
    ? weapon.projectile.speed
    : weapon.projectile.speed * weapon.projectile.falloffSpeedMultiplier;
  bullet.x += bullet.dx * flightSpeed * dt;
  bullet.y += bullet.dy * flightSpeed * dt;
  bullet.z += bullet.dz * flightSpeed * dt;
  bullet.dy -= weapon.projectile.gravity / flightSpeed * dt;
  const segmentDistance = Math.hypot(bullet.x - previous.x, bullet.y - previous.y, bullet.z - previous.z);
  const wallImpact = physics.castProjectile(previous, bullet, weapon.projectile.radius);
  const travelAmount = wallImpact?.amount ?? 1;
  const previousDistance = bullet.distanceTraveled;
  const nextDistance = previousDistance + segmentDistance * travelAmount;
  const trailPaintImpacts: Array<{ surfaceId: "ground"; x: number; y: number; z: number }> = [];
  const pattern = bullet.kind === "droplet" ? [] : weapon.paint.trailPatterns[bullet.seed % weapon.paint.trailPatterns.length];
  while (bullet.paintTrailIndex < pattern.length) {
    const distance = pattern[bullet.paintTrailIndex];
    if (distance > nextDistance) break;
    const amount = segmentDistance > 0
      ? Math.max(0, Math.min(travelAmount, (distance - previousDistance) / segmentDistance))
      : 0;
    const x = previous.x + (bullet.x - previous.x) * amount;
    const z = previous.z + (bullet.z - previous.z) * amount;
    const y = previous.y + (bullet.y - previous.y) * amount;
    if (Math.abs(x) <= level.halfSize && Math.abs(z) <= level.halfSize) {
      trailPaintImpacts.push({ surfaceId: "ground", x, y, z });
    }
    bullet.paintTrailIndex += 1;
  }
  bullet.distanceTraveled = nextDistance;

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
  const horizontal = input.surfaceId === "ground" || input.surfaceId.startsWith("top-");
  const surface = horizontal
    ? undefined
    : wallSurfaces.find((candidate) => candidate.id === input.surfaceId);
  if (!horizontal && !surface) return [];
  const directionU = horizontal
    ? input.directionX
    : surface!.axis === "x" ? input.directionZ : input.directionX;
  const directionV = horizontal ? input.directionZ : input.directionY;
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
    let radiusU = definition.mainRadius[0] * radiusScale;
    const radiusV = definition.mainRadius[1] * radiusScale *
      (isMain ? 1 : 0.88 + random01(markSeed ^ 0xc2b2ae35) * 0.34);
    let directionalCenterOffset = 0;
    if (
      isMain &&
      horizontal &&
      definition.floorForwardStretch
    ) {
      const horizontalSpeed = Math.hypot(input.directionX, input.directionZ);
      const impactAngleDegrees = Math.atan2(
        Math.abs(input.directionY),
        horizontalSpeed
      ) * 180 / Math.PI;
      const angleAmount = clamp01(
        (impactAngleDegrees - definition.floorForwardStretch.shallowAngleDegrees) /
        (
          definition.floorForwardStretch.steepAngleDegrees -
          definition.floorForwardStretch.shallowAngleDegrees
        )
      );
      const forwardExtent = definition.mainRadius[0] * interpolate(
        [
          definition.floorForwardStretch.shallowMultiplier,
          definition.floorForwardStretch.steepMultiplier
        ],
        angleAmount
      );
      const rearExtent =
        definition.mainRadius[0] *
        definition.floorForwardStretch.rearRadiusMultiplier;
      radiusU = (forwardExtent + rearExtent) / 2;
      directionalCenterOffset = (forwardExtent - rearExtent) / 2;
    }
    let { x, y, z } = input;
    if (horizontal) {
      x += offsetU + directionalCenterOffset * cos;
      z += offsetV + directionalCenterOffset * sin;
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
      kind: input.kind,
      originX: input.x,
      originY: input.y,
      originZ: input.z,
      surfaceId: input.surfaceId,
      x,
      y,
      z,
      radiusU,
      radiusV,
      rotation: baseRotation + (isMain ? 0 : randomSigned(markSeed ^ 0x9e3779b9) * 0.7)
    } as PaintStamp);
  }
  return marks;
}

export function bulletHitsPlayer(
  bullet: BulletSnapshot,
  player: Pick<PlayerSnapshot, "x" | "y" | "z" | "diving">,
  weapons: WeaponCatalog,
  from: { x: number; y: number; z: number } = bullet
) {
  const radius = player.diving ? PLAYER_DIVE_RADIUS : PLAYER_RADIUS;
  const height = player.diving ? PLAYER_DIVE_COLLIDER_HEIGHT : PLAYER_COLLIDER_HEIGHT;
  const lo = player.y + radius;
  const hi = player.y + height - radius;
  const vx = bullet.x - from.x, vy = bullet.y - from.y, vz = bullet.z - from.z;
  const lengthSquared = vx * vx + vy * vy + vz * vz;
  const expandedRadius = radius + weapons.get(bullet.weaponId).projectile.radius;
  const distanceAt = (t: number) => Math.hypot(
    from.x + vx * t - player.x,
    from.y + vy * t - Math.max(lo, Math.min(hi, from.y + vy * t)),
    from.z + vz * t - player.z
  );
  if (distanceAt(0) <= expandedRadius || distanceAt(1) <= expandedRadius) return true;
  if (lengthSquared < 1e-12) return false;
  for (const y of [lo, hi]) {
    const t = Math.max(0, Math.min(1, ((player.x - from.x) * vx + (y - from.y) * vy + (player.z - from.z) * vz) / lengthSquared));
    if (distanceAt(t) <= expandedRadius) return true;
  }
  const horizontalLength = vx * vx + vz * vz;
  if (horizontalLength < 1e-12) return false;
  const t = Math.max(0, Math.min(1, ((player.x - from.x) * vx + (player.z - from.z) * vz) / horizontalLength));
  return distanceAt(t) <= expandedRadius;
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

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
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
