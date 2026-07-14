import {
  ARENA_HALF_SIZE,
  ARENA_OBSTACLES,
  BULLET_GRAVITY,
  BULLET_RADIUS,
  BULLET_SPEED,
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
};

export type WallSurface = {
  id: WallSurfaceId;
  axis: "x" | "z";
  coordinate: number;
  minAlong: number;
  maxAlong: number;
  height: number;
  normalX: number;
  normalZ: number;
};

export type WallContact = WallSurface & {
  x: number;
  y: number;
  z: number;
};

declare const canvasUnitBrand: unique symbol;
export type CanvasUnit = number & { readonly [canvasUnitBrand]: "CanvasUnit" };
export type CanvasUv = { u: CanvasUnit; v: CanvasUnit };

function canvasUnit(value: number): CanvasUnit {
  return Math.max(0, Math.min(1, value)) as CanvasUnit;
}

export function groundPointToCanvasUv(point: { x: number; z: number }): CanvasUv {
  return {
    u: canvasUnit((point.x + ARENA_HALF_SIZE) / (ARENA_HALF_SIZE * 2)),
    v: canvasUnit(1 - (point.z + ARENA_HALF_SIZE) / (ARENA_HALF_SIZE * 2))
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
const BULLET_LIFETIME = 2.2;
const WALL_CLIMB_SPEED = 4.2;
export const ARENA_WALL_HEIGHT = 0.45;

const TEAM_SPAWNS = [
  [{ x: -7.5, z: -6.5 }, { x: -7.5, z: 6.5 }, { x: -4.5, z: 0 }],
  [{ x: 7.5, z: 6.5 }, { x: 7.5, z: -6.5 }, { x: 4.5, z: 0 }]
] as const;

export const WALL_SURFACES: readonly WallSurface[] = [
  ...ARENA_OBSTACLES.flatMap((box, index): WallSurface[] => [
    { id: `obstacle-${index}-px`, axis: "x", coordinate: box.x + box.width / 2, minAlong: box.z - box.depth / 2, maxAlong: box.z + box.depth / 2, height: box.height, normalX: 1, normalZ: 0 },
    { id: `obstacle-${index}-nx`, axis: "x", coordinate: box.x - box.width / 2, minAlong: box.z - box.depth / 2, maxAlong: box.z + box.depth / 2, height: box.height, normalX: -1, normalZ: 0 },
    { id: `obstacle-${index}-pz`, axis: "z", coordinate: box.z + box.depth / 2, minAlong: box.x - box.width / 2, maxAlong: box.x + box.width / 2, height: box.height, normalX: 0, normalZ: 1 },
    { id: `obstacle-${index}-nz`, axis: "z", coordinate: box.z - box.depth / 2, minAlong: box.x - box.width / 2, maxAlong: box.x + box.width / 2, height: box.height, normalX: 0, normalZ: -1 }
  ]),
  { id: "arena-east", axis: "x", coordinate: ARENA_HALF_SIZE, minAlong: -ARENA_HALF_SIZE, maxAlong: ARENA_HALF_SIZE, height: ARENA_WALL_HEIGHT, normalX: -1, normalZ: 0 },
  { id: "arena-west", axis: "x", coordinate: -ARENA_HALF_SIZE, minAlong: -ARENA_HALF_SIZE, maxAlong: ARENA_HALF_SIZE, height: ARENA_WALL_HEIGHT, normalX: 1, normalZ: 0 },
  { id: "arena-north", axis: "z", coordinate: ARENA_HALF_SIZE, minAlong: -ARENA_HALF_SIZE, maxAlong: ARENA_HALF_SIZE, height: ARENA_WALL_HEIGHT, normalX: 0, normalZ: -1 },
  { id: "arena-south", axis: "z", coordinate: -ARENA_HALF_SIZE, minAlong: -ARENA_HALF_SIZE, maxAlong: ARENA_HALF_SIZE, height: ARENA_WALL_HEIGHT, normalX: 0, normalZ: 1 }
];

export function createPlayer(id: string, name: string, team: TeamId, teamSlot = 0): PlayerSnapshot {
  const spawn = TEAM_SPAWNS[team][teamSlot % TEAM_SPAWNS[team].length];
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

export function respawnPlayer(player: PlayerSnapshot, teamSlot = 0) {
  const fresh = createPlayer(player.id, player.name, player.team, teamSlot);
  Object.assign(player, fresh);
}

export function stepPlayer(player: PlayerSnapshot, input: PlayerInput, dt: number) {
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

  const radius = player.diving ? PLAYER_DIVE_RADIUS : PLAYER_RADIUS;
  const nextX = clampArena(player.x + player.vx * dt, radius);
  if (!hitsObstacle(nextX, player.z, player.y, radius)) player.x = nextX;
  else player.vx = 0;
  const nextZ = clampArena(player.z + player.vz * dt, radius);
  if (!hitsObstacle(player.x, nextZ, player.y, radius)) player.z = nextZ;
  else player.vz = 0;
}

export function spawnBullet(
  id: string,
  player: PlayerSnapshot,
  direction: { x: number; y: number; z: number },
  forward: { x: number; z: number },
  right: { x: number; z: number }
): BulletSnapshot {
  return {
    id,
    ownerId: player.id,
    team: player.team,
    x: player.x + forward.x * 0.72 + right.x * 0.34,
    y: player.y + 0.82,
    z: player.z + forward.z * 0.72 + right.z * 0.34,
    dx: direction.x,
    dy: direction.y,
    dz: direction.z,
    age: 0
  };
}

export function stepBullet(bullet: BulletSnapshot, dt: number): BulletStepResult {
  const previousX = bullet.x;
  const previousY = bullet.y;
  const previousZ = bullet.z;
  bullet.age += dt;
  bullet.x += bullet.dx * BULLET_SPEED * dt;
  bullet.y += bullet.dy * BULLET_SPEED * dt;
  bullet.z += bullet.dz * BULLET_SPEED * dt;
  bullet.dy -= BULLET_GRAVITY / BULLET_SPEED * dt;
  const groundAmount = previousY > BULLET_RADIUS && bullet.y <= BULLET_RADIUS
    ? (previousY - BULLET_RADIUS) / (previousY - bullet.y)
    : undefined;
  const wallImpact = findBulletWallImpact(
    { x: previousX, y: previousY, z: previousZ },
    { x: bullet.x, y: bullet.y, z: bullet.z }
  );
  if (groundAmount !== undefined && (!wallImpact || groundAmount <= wallImpact.amount)) {
    bullet.x = previousX + (bullet.x - previousX) * groundAmount;
    bullet.y = BULLET_RADIUS;
    bullet.z = previousZ + (bullet.z - previousZ) * groundAmount;
    return { alive: false, paintImpact: { surfaceId: "ground", x: bullet.x, y: 0, z: bullet.z } };
  }
  if (wallImpact) {
    bullet.x = previousX + (bullet.x - previousX) * wallImpact.amount;
    bullet.y = previousY + (bullet.y - previousY) * wallImpact.amount;
    bullet.z = previousZ + (bullet.z - previousZ) * wallImpact.amount;
    return { alive: false, paintImpact: wallImpact.impact };
  }
  const alive = !(
    bullet.age >= BULLET_LIFETIME ||
    bullet.y > 8 ||
    Math.abs(bullet.x) > ARENA_HALF_SIZE + BULLET_RADIUS ||
    Math.abs(bullet.z) > ARENA_HALF_SIZE + BULLET_RADIUS
  );
  return { alive };
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
    const min = this.worldToCell(stamp.x - stamp.radius, stamp.z - stamp.radius, true)!;
    const max = this.worldToCell(stamp.x + stamp.radius, stamp.z + stamp.radius, true)!;
    const radiusSquared = stamp.radius * stamp.radius;
    for (let z = min.z; z <= max.z; z += 1) {
      for (let x = min.x; x <= max.x; x += 1) {
        const world = this.cellToWorld(x, z);
        if ((world.x - stamp.x) ** 2 + (world.z - stamp.z) ** 2 <= radiusSquared) {
          this.cells[z * this.size + x] = stamp.team;
        }
      }
    }
  }

  teamAtWall(surfaceId: string, x: number, y: number, z: number): TeamId | null {
    const stamps = this.wallStamps.get(surfaceId);
    if (!stamps) return null;
    for (let index = stamps.length - 1; index >= 0; index -= 1) {
      const stamp = stamps[index];
      if ((x - stamp.x) ** 2 + (y - stamp.y) ** 2 + (z - stamp.z) ** 2 <= stamp.radius ** 2) return stamp.team;
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

export function findWallContact(player: PlayerSnapshot): WallContact | undefined {
  const radius = player.diving ? PLAYER_DIVE_RADIUS : PLAYER_RADIUS;
  let closest: (WallContact & { distance: number }) | undefined;
  for (const surface of WALL_SURFACES) {
    if (player.y > surface.height) continue;
    const along = surface.axis === "x" ? player.z : player.x;
    if (along < surface.minAlong - radius || along > surface.maxAlong + radius) continue;
    const signedDistance = surface.axis === "x"
      ? (player.x - surface.coordinate) * surface.normalX
      : (player.z - surface.coordinate) * surface.normalZ;
    if (signedDistance < -0.05 || signedDistance > radius + 0.18 || (closest && signedDistance >= closest.distance)) continue;
    closest = {
      ...surface,
      x: surface.axis === "x" ? surface.coordinate : player.x,
      y: Math.min(surface.height, player.y + radius),
      z: surface.axis === "z" ? surface.coordinate : player.z,
      distance: signedDistance
    };
  }
  return closest;
}

function findBulletWallImpact(
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number }
) {
  let closest: { amount: number; impact: { surfaceId: WallSurfaceId; x: number; y: number; z: number } } | undefined;
  for (const surface of WALL_SURFACES) {
    const fromAxis = surface.axis === "x" ? from.x : from.z;
    const toAxis = surface.axis === "x" ? to.x : to.z;
    const fromDistance = (fromAxis - surface.coordinate) * (surface.axis === "x" ? surface.normalX : surface.normalZ);
    const toDistance = (toAxis - surface.coordinate) * (surface.axis === "x" ? surface.normalX : surface.normalZ);
    if (fromDistance < BULLET_RADIUS || toDistance >= BULLET_RADIUS || fromDistance === toDistance) continue;
    const amount = (fromDistance - BULLET_RADIUS) / (fromDistance - toDistance);
    if (amount < 0 || amount > 1 || (closest && amount >= closest.amount)) continue;
    const x = from.x + (to.x - from.x) * amount;
    const y = from.y + (to.y - from.y) * amount;
    const z = from.z + (to.z - from.z) * amount;
    if (y < -BULLET_RADIUS || y > surface.height + BULLET_RADIUS) continue;
    const along = surface.axis === "x" ? z : x;
    if (along < surface.minAlong - BULLET_RADIUS || along > surface.maxAlong + BULLET_RADIUS) continue;
    closest = {
      amount,
      impact: {
        surfaceId: surface.id,
        x: surface.axis === "x" ? surface.coordinate : x,
        y: Math.max(0, Math.min(surface.height, y)),
        z: surface.axis === "z" ? surface.coordinate : z
      }
    };
  }
  return closest;
}

export function bulletHitsPlayer(bullet: BulletSnapshot, player: PlayerSnapshot) {
  const radius = player.diving ? PLAYER_DIVE_RADIUS : PLAYER_RADIUS;
  const height = player.diving ? PLAYER_DIVE_COLLIDER_HEIGHT : PLAYER_COLLIDER_HEIGHT;
  const capsuleBottom = player.y + radius;
  const capsuleTop = player.y + height - radius;
  const nearestY = Math.max(capsuleBottom, Math.min(capsuleTop, bullet.y));
  return Math.hypot(bullet.x - player.x, bullet.y - nearestY, bullet.z - player.z) <= radius + BULLET_RADIUS;
}

function hitsObstacle(x: number, z: number, y: number, radius: number) {
  return ARENA_OBSTACLES.some((box) => {
    if (y >= box.height) return false;
    const nearestX = Math.max(box.x - box.width / 2, Math.min(box.x + box.width / 2, x));
    const nearestZ = Math.max(box.z - box.depth / 2, Math.min(box.z + box.depth / 2, z));
    return Math.hypot(x - nearestX, z - nearestZ) <= radius;
  });
}

function clampArena(value: number, radius: number) {
  return Math.max(-ARENA_HALF_SIZE + radius, Math.min(ARENA_HALF_SIZE - radius, value));
}

function approach(current: number, target: number, maxDelta: number) {
  if (current < target) return Math.min(current + maxDelta, target);
  if (current > target) return Math.max(current - maxDelta, target);
  return target;
}
