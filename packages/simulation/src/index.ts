import {
  ARENA_HALF_SIZE,
  PLAYER_COLLIDER_HEIGHT,
  PLAYER_DIVE_COLLIDER_HEIGHT,
  PLAYER_DIVE_RADIUS,
  PLAYER_MAX_HP,
  PLAYER_RADIUS,
  type BulletSnapshot,
  type PaintSurfaceId,
  type PlayerSnapshot,
  type PaintStamp,
  type TeamId,
  type WallSurfaceId
} from "@tofu/protocol";
import {
  createLevelWallSurfaces,
  getTeamSpawn,
  TOFU_TEST_LEVEL,
  type LevelDefinition,
  type WallSurface
} from "./level.js";
import {
  AnalyticPhysicsAdapter,
  playerCollider,
  type PhysicsAdapter,
  type WallContact
} from "./physics.js";
import {
  SPLATTERSHOT,
  getWeaponDefinition,
  type WeaponDefinition
} from "./weapons.js";

export type PlayerInput = {
  moveX: number;
  moveZ: number;
  jumpPressed: boolean;
  diving: boolean;
  groundTeam: TeamId | null;
  wallContact?: WallContact & { team: TeamId | null };
};

export type BulletStepResult = {
  alive: boolean;
  paintImpact?: { surfaceId: PaintSurfaceId; x: number; y: number; z: number };
  trailPaintImpacts: Array<{ surfaceId: "ground"; x: number; y: 0; z: number }>;
};

export type PaintSplatKind = "trail" | "impact" | "foot";
export type PaintSplatInput = {
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

declare const canvasUnitBrand: unique symbol;
export type CanvasUnit = number & { readonly [canvasUnitBrand]: "CanvasUnit" };
export type CanvasUv = { u: CanvasUnit; v: CanvasUnit };

function canvasUnit(value: number): CanvasUnit {
  return Math.max(0, Math.min(1, value)) as CanvasUnit;
}

export function groundPointToCanvasUv(
  point: { x: number; z: number },
  halfSize = TOFU_TEST_LEVEL.halfSize
): CanvasUv {
  return {
    u: canvasUnit((point.x + halfSize) / (halfSize * 2)),
    v: canvasUnit(1 - (point.z + halfSize) / (halfSize * 2))
  };
}

export function wallPointToCanvasUv(
  surface: WallSurface,
  point: { x: number; y: number; z: number }
): CanvasUv {
  const along = surface.axis === "x" ? point.z : point.x;
  const alongAmount = (along - surface.minAlong) / (surface.maxAlong - surface.minAlong);
  const invertAlong = surface.axis === "x" ? surface.normalX < 0 : surface.normalZ > 0;
  return {
    // Each single-sided plane is rotated so its normal matches the contact side.
    u: canvasUnit(invertAlong ? 1 - alongAmount : alongAmount),
    v: canvasUnit(1 - point.y / surface.height)
  };
}

const PLAYER_MAX_SPEED = 5.5;
const PLAYER_DIVE_SPEED = 7.4;
const PLAYER_ACCELERATION = 30;
const PLAYER_BRAKING = 42;
const JUMP_VELOCITY = 7.2;
const GRAVITY = 20;
const WALL_CLIMB_SPEED = 4.2;
export const ARENA_WALL_HEIGHT = TOFU_TEST_LEVEL.arenaWallHeight;

export const SPLATTERSHOT_PROFILE = {
  id: SPLATTERSHOT.id,
  displayName: SPLATTERSHOT.displayName,
  fireIntervalSeconds: SPLATTERSHOT.fireIntervalSeconds,
  damage: SPLATTERSHOT.damage,
  groundSpreadDegrees: SPLATTERSHOT.spread.groundDegrees,
  airSpreadDegrees: SPLATTERSHOT.spread.airDegrees,
  paintRange: SPLATTERSHOT.projectile.paintRange,
  falloffSpeedMultiplier: SPLATTERSHOT.projectile.falloffSpeedMultiplier,
  footPaintEveryShots: SPLATTERSHOT.paint.footEveryShots,
  dropletPatternCount: SPLATTERSHOT.paint.trailPatterns.length
} as const;

export const WALL_SURFACES: readonly WallSurface[] = createLevelWallSurfaces(TOFU_TEST_LEVEL);
const DEFAULT_PHYSICS = new AnalyticPhysicsAdapter(TOFU_TEST_LEVEL);

export function createPlayer(
  id: string,
  name: string,
  team: TeamId,
  teamSlot = 0,
  level: LevelDefinition = TOFU_TEST_LEVEL
): PlayerSnapshot {
  const spawn = getTeamSpawn(level, team, teamSlot);
  return {
    id,
    name,
    team,
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

export function respawnPlayer(player: PlayerSnapshot, teamSlot = 0, level: LevelDefinition = TOFU_TEST_LEVEL) {
  const fresh = createPlayer(player.id, player.name, player.team, teamSlot, level);
  Object.assign(player, fresh);
}

export function stepPlayer(
  player: PlayerSnapshot,
  input: PlayerInput,
  dt: number,
  physics: PhysicsAdapter = DEFAULT_PHYSICS
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
    player.y = Math.min(wall.height, player.y + climbInput * WALL_CLIMB_SPEED * dt);
    const radius = PLAYER_DIVE_RADIUS;
    player.x = wall.x + wall.normalX * radius;
    player.z = wall.z + wall.normalZ * radius;
    return;
  }
  player.wallAttached = false;
  player.wallSurfaceId = "";
  const grounded = player.y <= 0.0001;
  if (input.jumpPressed && grounded && !input.diving) {
    player.vy = JUMP_VELOCITY;
    player.diving = false;
  } else {
    player.diving = input.diving && grounded;
  }

  const onOwnInk = input.groundTeam === player.team;
  const maxSpeed = player.diving && onOwnInk ? PLAYER_DIVE_SPEED : PLAYER_MAX_SPEED;
  const hasInput = Math.hypot(input.moveX, input.moveZ) > 0.01;
  const acceleration = hasInput ? PLAYER_ACCELERATION : PLAYER_BRAKING;
  player.vx = approach(player.vx, input.moveX * maxSpeed, acceleration * dt);
  player.vz = approach(player.vz, input.moveZ * maxSpeed, acceleration * dt);

  const speed = Math.hypot(player.vx, player.vz);
  if (speed > 0.05) {
    player.facingX = player.vx / speed;
    player.facingZ = player.vz / speed;
  }

  player.vy -= GRAVITY * dt;
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

export function spawnBullet(
  id: string,
  player: PlayerSnapshot,
  direction: { x: number; y: number; z: number },
  forward: { x: number; z: number },
  right: { x: number; z: number },
  weapon: WeaponDefinition = SPLATTERSHOT
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

export function stepBullet(
  bullet: BulletSnapshot,
  dt: number,
  physics: PhysicsAdapter = DEFAULT_PHYSICS,
  level: LevelDefinition = TOFU_TEST_LEVEL
): BulletStepResult {
  const weapon = getWeaponDefinition(bullet.weaponId);
  const previousX = bullet.x;
  const previousY = bullet.y;
  const previousZ = bullet.z;
  bullet.age += dt;
  const flightSpeed = bullet.distanceTraveled < weapon.projectile.paintRange
    ? weapon.projectile.speed
    : weapon.projectile.speed * weapon.projectile.falloffSpeedMultiplier;
  bullet.x += bullet.dx * flightSpeed * dt;
  bullet.y += bullet.dy * flightSpeed * dt;
  bullet.z += bullet.dz * flightSpeed * dt;
  bullet.dy -= weapon.projectile.gravity / flightSpeed * dt;
  const segmentDistance = Math.hypot(bullet.x - previousX, bullet.y - previousY, bullet.z - previousZ);
  const groundAmount = previousY > weapon.projectile.radius && bullet.y <= weapon.projectile.radius
    ? (previousY - weapon.projectile.radius) / (previousY - bullet.y)
    : undefined;
  const wallImpact = physics.castProjectile(
    { x: previousX, y: previousY, z: previousZ },
    { x: bullet.x, y: bullet.y, z: bullet.z },
    weapon.projectile.radius
  );
  const groundWins = groundAmount !== undefined && (!wallImpact || groundAmount <= wallImpact.amount);
  const collisionAmount = groundWins ? groundAmount : wallImpact?.amount;
  const previousDistance = bullet.distanceTraveled;
  const travelAmount = collisionAmount ?? 1;
  const traveledThisStep = segmentDistance * travelAmount;
  const nextDistance = previousDistance + traveledThisStep;
  const trailPaintImpacts: BulletStepResult["trailPaintImpacts"] = [];
  const trailPattern = weapon.paint.trailPatterns[bullet.seed % weapon.paint.trailPatterns.length];
  while (bullet.paintTrailIndex < trailPattern.length) {
    const trailDistance = trailPattern[bullet.paintTrailIndex];
    if (trailDistance > nextDistance) break;
    const amount = segmentDistance > 0 ? Math.max(0, Math.min(travelAmount, (trailDistance - previousDistance) / segmentDistance)) : 0;
    const x = previousX + (bullet.x - previousX) * amount;
    const z = previousZ + (bullet.z - previousZ) * amount;
    if (Math.abs(x) <= level.halfSize && Math.abs(z) <= level.halfSize) {
      trailPaintImpacts.push({ surfaceId: "ground", x, y: 0, z });
    }
    bullet.paintTrailIndex += 1;
  }
  bullet.distanceTraveled = nextDistance;
  if (groundWins) {
    bullet.x = previousX + (bullet.x - previousX) * groundAmount;
    bullet.y = weapon.projectile.radius;
    bullet.z = previousZ + (bullet.z - previousZ) * groundAmount;
    return { alive: false, trailPaintImpacts, paintImpact: { surfaceId: "ground", x: bullet.x, y: 0, z: bullet.z } };
  }
  if (wallImpact) {
    bullet.x = previousX + (bullet.x - previousX) * wallImpact.amount;
    bullet.y = previousY + (bullet.y - previousY) * wallImpact.amount;
    bullet.z = previousZ + (bullet.z - previousZ) * wallImpact.amount;
    return { alive: false, trailPaintImpacts, paintImpact: wallImpact.impact };
  }
  const alive = !(
    bullet.age >= weapon.projectile.lifetime ||
    bullet.y > 8 ||
    Math.abs(bullet.x) > level.halfSize + weapon.projectile.radius ||
    Math.abs(bullet.z) > level.halfSize + weapon.projectile.radius
  );
  return { alive, trailPaintImpacts };
}

export function createWeaponPaintStamps(
  input: PaintSplatInput,
  weapon: WeaponDefinition = SPLATTERSHOT,
  wallSurfaces: readonly WallSurface[] = WALL_SURFACES
): PaintStamp[] {
  const surface = input.surfaceId === "ground" ? undefined : wallSurfaces.find((candidate) => candidate.id === input.surfaceId);
  if (input.surfaceId !== "ground" && !surface) return [];
  const directionU = input.surfaceId === "ground"
    ? input.directionX
    : surface!.axis === "x" ? input.directionZ : input.directionX;
  const directionV = input.surfaceId === "ground" ? input.directionZ : input.directionY;
  const baseRotation = Math.atan2(directionV, directionU);
  const [mainRadiusU, mainRadiusV] = input.kind === "impact"
    ? weapon.paint.impactMainRadius
    : input.kind === "foot"
      ? weapon.paint.footMainRadius
      : weapon.paint.trailMainRadius;
  const satelliteCount = input.kind === "impact" ? 5 : 2;
  const marks: PaintStamp[] = [];

  for (let index = 0; index <= satelliteCount; index += 1) {
    const markSeed = input.seed ^ Math.imul(index + 1, 0x45d9f3b);
    const isMain = index === 0;
    const side = randomSigned(markSeed);
    const forward = isMain ? 0 : 0.32 + random01(markSeed ^ 0x27d4eb2d) * (input.kind === "impact" ? 0.72 : 0.34);
    const lateral = isMain ? 0 : side * (0.16 + random01(markSeed ^ 0x165667b1) * 0.42);
    const cos = Math.cos(baseRotation);
    const sin = Math.sin(baseRotation);
    const offsetU = forward * cos - lateral * sin;
    const offsetV = forward * sin + lateral * cos;
    const radiusScale = isMain ? 1 : 0.2 + random01(markSeed ^ 0x85ebca6b) * 0.32;
    let x = input.x;
    let y = input.y;
    let z = input.z;
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
      radiusU: mainRadiusU * radiusScale,
      radiusV: mainRadiusV * radiusScale * (isMain ? 1 : 0.88 + random01(markSeed ^ 0xc2b2ae35) * 0.34),
      rotation: baseRotation + randomSigned(markSeed ^ 0x9e3779b9) * (isMain ? 0.16 : 0.7)
    } as PaintStamp);
  }
  return marks;
}

export function createSplattershotPaintStamps(input: PaintSplatInput): PaintStamp[] {
  return createWeaponPaintStamps(input, SPLATTERSHOT, WALL_SURFACES);
}

export class InkField {
  private readonly cells: Uint8Array;
  private readonly wallStamps = new Map<string, PaintStamp[]>();

  constructor(readonly size = 96) {
    this.cells = new Uint8Array(size * size);
    this.cells.fill(255);
  }

  teamAt(x: number, z: number): TeamId | null {
    const cell = this.worldToCell(x, z);
    if (!cell) return null;
    const value = this.cells[cell.z * this.size + cell.x];
    return value === 0 || value === 1 ? value : null;
  }

  paint(stamp: PaintStamp) {
    if (stamp.surfaceId !== "ground") {
      const stamps = this.wallStamps.get(stamp.surfaceId) ?? [];
      stamps.push(stamp);
      this.wallStamps.set(stamp.surfaceId, stamps);
      return;
    }
    const maxRadius = Math.max(stamp.radiusU, stamp.radiusV);
    const min = this.worldToCell(stamp.x - maxRadius, stamp.z - maxRadius, true)!;
    const max = this.worldToCell(stamp.x + maxRadius, stamp.z + maxRadius, true)!;
    for (let z = min.z; z <= max.z; z += 1) {
      for (let x = min.x; x <= max.x; x += 1) {
        const world = this.cellToWorld(x, z);
        if (ellipseContains(world.x - stamp.x, world.z - stamp.z, stamp.radiusU, stamp.radiusV, stamp.rotation)) {
          this.cells[z * this.size + x] = stamp.team;
        }
      }
    }
  }

  teamAtWall(surfaceId: string, x: number, y: number, z: number): TeamId | null {
    const stamps = this.wallStamps.get(surfaceId);
    if (!stamps) return null;
    const surface = WALL_SURFACES.find((candidate) => candidate.id === surfaceId);
    if (!surface) return null;
    const pointU = surface.axis === "x" ? z : x;
    for (let index = stamps.length - 1; index >= 0; index -= 1) {
      const stamp = stamps[index];
      const stampU = surface.axis === "x" ? stamp.z : stamp.x;
      if (ellipseContains(pointU - stampU, y - stamp.y, stamp.radiusU, stamp.radiusV, stamp.rotation)) return stamp.team;
    }
    return null;
  }

  private worldToCell(x: number, z: number, clamp = false) {
    const cellX = Math.floor((x + ARENA_HALF_SIZE) / (ARENA_HALF_SIZE * 2) * this.size);
    const cellZ = Math.floor((z + ARENA_HALF_SIZE) / (ARENA_HALF_SIZE * 2) * this.size);
    if (!clamp && (cellX < 0 || cellX >= this.size || cellZ < 0 || cellZ >= this.size)) return undefined;
    return {
      x: Math.max(0, Math.min(this.size - 1, cellX)),
      z: Math.max(0, Math.min(this.size - 1, cellZ))
    };
  }

  private cellToWorld(x: number, z: number) {
    return {
      x: (x + 0.5) / this.size * ARENA_HALF_SIZE * 2 - ARENA_HALF_SIZE,
      z: (z + 0.5) / this.size * ARENA_HALF_SIZE * 2 - ARENA_HALF_SIZE
    };
  }
}

export function findWallContact(
  player: PlayerSnapshot,
  physics: PhysicsAdapter = DEFAULT_PHYSICS
): WallContact | undefined {
  return physics.findWallContact(player);
}

export function bulletHitsPlayer(bullet: BulletSnapshot, player: PlayerSnapshot) {
  const radius = player.diving ? PLAYER_DIVE_RADIUS : PLAYER_RADIUS;
  const height = player.diving ? PLAYER_DIVE_COLLIDER_HEIGHT : PLAYER_COLLIDER_HEIGHT;
  const capsuleBottom = player.y + radius;
  const capsuleTop = player.y + height - radius;
  const nearestY = Math.max(capsuleBottom, Math.min(capsuleTop, bullet.y));
  return Math.hypot(bullet.x - player.x, bullet.y - nearestY, bullet.z - player.z) <=
    radius + getWeaponDefinition(bullet.weaponId).projectile.radius;
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

function ellipseContains(deltaU: number, deltaV: number, radiusU: number, radiusV: number, rotation: number) {
  if (radiusU <= 0 || radiusV <= 0) return false;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const localU = deltaU * cos + deltaV * sin;
  const localV = -deltaU * sin + deltaV * cos;
  return (localU / radiusU) ** 2 + (localV / radiusV) ** 2 <= 1;
}

function approach(current: number, target: number, maxDelta: number) {
  if (current < target) return Math.min(current + maxDelta, target);
  if (current > target) return Math.max(current - maxDelta, target);
  return target;
}
