import {
  PLAYER_COLLIDER_HEIGHT,
  PLAYER_DIVE_COLLIDER_HEIGHT,
  PLAYER_DIVE_RADIUS,
  PLAYER_RADIUS,
  type PaintSurfaceId,
  type PhysicsKind,
  type PlayerSnapshot,
  type WallSurfaceId
} from "@tofu/protocol";
import { createLevelWallSurfaces, type LevelDefinition, type WallSurface } from "./level.js";

export type Vec3 = { x: number; y: number; z: number };

export type ProjectileImpact = {
  amount: number;
  impact: { surfaceId: PaintSurfaceId; x: number; y: number; z: number };
};

export type WallContact = WallSurface & { x: number; y: number; z: number };

export interface PhysicsAdapter {
  readonly kind: PhysicsKind;
  resolvePlayerMovement(
    player: PlayerSnapshot,
    delta: { x: number; z: number },
    collider: { radius: number; height: number }
  ): { x: number; z: number; blockedX: boolean; blockedZ: boolean };
  findWallContact(player: PlayerSnapshot): WallContact | undefined;
  castProjectile(from: Vec3, to: Vec3, radius: number): ProjectileImpact | undefined;
  dispose(): void;
}

export class AnalyticPhysicsAdapter implements PhysicsAdapter {
  readonly kind = "analytic" as const;
  private readonly surfaces: readonly WallSurface[];

  constructor(private readonly level: LevelDefinition) {
    this.surfaces = createLevelWallSurfaces(level);
  }

  resolvePlayerMovement(
    player: PlayerSnapshot,
    delta: { x: number; z: number },
    collider: { radius: number; height: number }
  ) {
    const min = -this.level.halfSize + collider.radius;
    const max = this.level.halfSize - collider.radius;
    const desiredX = clamp(player.x + delta.x, min, max);
    const x = this.hitsObstacle(desiredX, player.z, player.y, collider.radius, collider.height) ? player.x : desiredX;
    const desiredZ = clamp(player.z + delta.z, min, max);
    const z = this.hitsObstacle(x, desiredZ, player.y, collider.radius, collider.height) ? player.z : desiredZ;
    return {
      x,
      z,
      blockedX: x !== desiredX,
      blockedZ: z !== desiredZ
    };
  }

  findWallContact(player: PlayerSnapshot): WallContact | undefined {
    const radius = player.diving ? PLAYER_DIVE_RADIUS : PLAYER_RADIUS;
    let closest: (WallContact & { distance: number }) | undefined;
    for (const surface of this.surfaces) {
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
    if (!closest) return undefined;
    const { distance: _distance, ...contact } = closest;
    return contact;
  }

  castProjectile(from: Vec3, to: Vec3, radius: number): ProjectileImpact | undefined {
    let closest: ProjectileImpact | undefined;
    for (const surface of this.surfaces) {
      const fromAxis = surface.axis === "x" ? from.x : from.z;
      const toAxis = surface.axis === "x" ? to.x : to.z;
      const normal = surface.axis === "x" ? surface.normalX : surface.normalZ;
      const fromDistance = (fromAxis - surface.coordinate) * normal;
      const toDistance = (toAxis - surface.coordinate) * normal;
      if (fromDistance < radius || toDistance >= radius || fromDistance === toDistance) continue;
      const amount = (fromDistance - radius) / (fromDistance - toDistance);
      if (amount < 0 || amount > 1 || (closest && amount >= closest.amount)) continue;
      const x = from.x + (to.x - from.x) * amount;
      const y = from.y + (to.y - from.y) * amount;
      const z = from.z + (to.z - from.z) * amount;
      if (y < -radius || y > surface.height + radius) continue;
      const along = surface.axis === "x" ? z : x;
      if (along < surface.minAlong - radius || along > surface.maxAlong + radius) continue;
      closest = {
        amount,
        impact: {
          surfaceId: surface.id,
          x: surface.axis === "x" ? surface.coordinate : x,
          y: clamp(y, 0, surface.height),
          z: surface.axis === "z" ? surface.coordinate : z
        }
      };
    }
    return closest;
  }

  dispose() {}

  private hitsObstacle(x: number, z: number, y: number, radius: number, height: number) {
    return this.level.obstacles.some((box) => {
      if (y >= box.height || y + height <= 0) return false;
      const nearestX = clamp(x, box.x - box.width / 2, box.x + box.width / 2);
      const nearestZ = clamp(z, box.z - box.depth / 2, box.z + box.depth / 2);
      return Math.hypot(x - nearestX, z - nearestZ) <= radius;
    });
  }
}

export function playerCollider(player: PlayerSnapshot) {
  return player.diving
    ? { radius: PLAYER_DIVE_RADIUS, height: PLAYER_DIVE_COLLIDER_HEIGHT }
    : { radius: PLAYER_RADIUS, height: PLAYER_COLLIDER_HEIGHT };
}

export function surfaceIdFromNormal(
  boxIndex: number,
  normal: Vec3
): WallSurfaceId {
  if (Math.abs(normal.x) >= Math.abs(normal.z)) return `obstacle-${boxIndex}-${normal.x >= 0 ? "px" : "nx"}`;
  return `obstacle-${boxIndex}-${normal.z >= 0 ? "pz" : "nz"}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
