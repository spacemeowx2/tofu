import RAPIER from "@dimforge/rapier3d-compat";
import type { PaintSurfaceId, PlayerSnapshot, WallSurfaceId } from "@tofu/protocol";
import { createLevelWallSurfaces, type LevelDefinition, type WallSurface } from "./level.js";
import {
  playerCollider,
  type PhysicsAdapter,
  type ProjectileImpact,
  type Vec3,
  type WallContact
} from "./physics.js";

type ColliderMetadata =
  | { kind: "ground" }
  | { kind: "obstacle"; boxIndex: number }
  | { kind: "arena"; surfaceId: WallSurfaceId };

const IDENTITY = { w: 1, x: 0, y: 0, z: 0 };
let rapierInitialization: Promise<void> | undefined;

export async function createRapierPhysicsAdapter(level: LevelDefinition): Promise<RapierPhysicsAdapter> {
  rapierInitialization ??= RAPIER.init();
  await rapierInitialization;
  return new RapierPhysicsAdapter(level);
}

export class RapierPhysicsAdapter implements PhysicsAdapter {
  readonly kind = "rapier" as const;
  private readonly world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  private readonly metadata = new Map<number, ColliderMetadata>();
  private readonly characters = new Map<string, RAPIER.Collider>();
  private readonly controller: RAPIER.KinematicCharacterController;
  private readonly surfaces: readonly WallSurface[];
  private readonly surfaceById: ReadonlyMap<WallSurfaceId, WallSurface>;

  constructor(private readonly level: LevelDefinition) {
    this.controller = this.world.createCharacterController(0.01);
    this.controller.enableSnapToGround(0.12);
    const floor = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(level.halfSize, 0.1, level.halfSize).setTranslation(0, -0.1, 0)
    );
    this.metadata.set(floor.handle, { kind: "ground" });
    this.surfaces = createLevelWallSurfaces(level);
    this.surfaceById = new Map(this.surfaces.map((surface) => [surface.id, surface]));
    level.obstacles.forEach((box, boxIndex) => {
      const collider = this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(box.width / 2, box.height / 2, box.depth / 2)
          .setTranslation(box.x, box.height / 2, box.z)
      );
      this.metadata.set(collider.handle, { kind: "obstacle", boxIndex });
    });
    this.createArenaWalls();
    // Rapier's broad phase is populated during a world step. The adapter owns
    // static query geometry only, so a zero-gravity step makes it query-ready.
    this.world.step();
  }

  resolvePlayerMovement(
    player: PlayerSnapshot,
    delta: Vec3,
    collider: { radius: number; height: number }
  ) {
    const shape = new RAPIER.Capsule(Math.max(0, (collider.height - collider.radius * 2) / 2), collider.radius);
    let character = this.characters.get(player.id);
    if (!character) {
      character = this.world.createCollider(RAPIER.ColliderDesc.capsule(shape.halfHeight, shape.radius).setCollisionGroups(0x00020001));
      this.characters.set(player.id, character);
    }
    character.setShape(shape);
    character.setTranslation({ x: player.x, y: player.y + collider.height / 2, z: player.z });
    this.world.step();
    this.controller.computeColliderMovement(character, delta, undefined, 0x00010001);
    const movement = this.controller.computedMovement();
    return {
      x: player.x + movement.x,
      y: player.y + movement.y,
      z: player.z + movement.z,
      blockedX: Math.abs(movement.x - delta.x) > 0.001,
      blockedY: Math.abs(movement.y - delta.y) > 0.001,
      blockedZ: Math.abs(movement.z - delta.z) > 0.001,
      grounded: this.controller.computedGrounded()
    };
  }

  findWallContact(player: PlayerSnapshot): WallContact | undefined {
    const { radius, height } = playerCollider(player);
    const shape = new RAPIER.Capsule(Math.max(0, (height - radius * 2) / 2), radius);
    const position = { x: player.x, y: player.y + height / 2, z: player.z };
    const probeDistance = 0.2;
    const probes = [
      { x: probeDistance, y: 0, z: 0 },
      { x: -probeDistance, y: 0, z: 0 },
      { x: 0, y: 0, z: probeDistance },
      { x: 0, y: 0, z: -probeDistance }
    ];
    let closest: { distance: number; surface: WallSurface } | undefined;
    for (const velocity of probes) {
      const hit = this.world.castShape(position, IDENTITY, velocity, shape, 0.001, 1, true, undefined, 0x00010001);
      if (!hit) continue;
      if (Math.abs(hit.normal1.y) > 0.5) continue;
      const id = this.surfaceForHit(hit.collider.handle, hit.normal1);
      const surface = this.surfaceById.get(id as WallSurfaceId);
      if (!surface || player.y > surface.height) continue;
      const distance = hit.time_of_impact * probeDistance;
      if (!closest || distance < closest.distance) closest = { distance, surface };
    }
    if (!closest) return undefined;
    const surface = closest.surface;
    return {
      ...surface,
      x: surface.axis === "x" ? surface.coordinate : player.x,
      y: Math.min(surface.height, player.y + radius),
      z: surface.axis === "z" ? surface.coordinate : player.z
    };
  }

  castProjectile(from: Vec3, to: Vec3, radius: number): ProjectileImpact | undefined {
    const velocity = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
    const hit = this.world.castShape(from, IDENTITY, velocity, new RAPIER.Ball(radius), 0, 1, true, undefined, 0x00010001);
    if (!hit) return undefined;
    const surfaceId = this.surfaceForHit(hit.collider.handle, hit.normal1);
    if (!surfaceId) return undefined;
    const amount = hit.time_of_impact;
    const x = from.x + velocity.x * amount;
    const y = from.y + velocity.y * amount;
    const z = from.z + velocity.z * amount;
    if (surfaceId === "ground" || surfaceId.startsWith("top-")) {
      const height = surfaceId === "ground" ? 0 : this.level.obstacles[Number(surfaceId.slice(4))].height;
      return { amount, impact: { surfaceId, x, y: height, z } };
    }
    const surface = this.surfaceById.get(surfaceId as WallSurfaceId)!;
    return {
      amount,
      impact: {
        surfaceId: surface.id,
        x: surface.axis === "x" ? surface.coordinate : x,
        y: Math.max(0, Math.min(surface.height, y)),
        z: surface.axis === "z" ? surface.coordinate : z
      }
    };
  }

  dispose() {
    this.world.free();
  }

  removePlayer(id: string) {
    const collider = this.characters.get(id);
    if (collider) this.world.removeCollider(collider, false);
    this.characters.delete(id);
  }

  private surfaceForHit(handle: number, normal: Vec3): PaintSurfaceId | undefined {
    const metadata = this.metadata.get(handle);
    if (!metadata) return undefined;
    if (metadata.kind === "ground") return "ground";
    if (metadata.kind === "arena") return metadata.surfaceId;
    if (normal.y > 0.5) return `top-${metadata.boxIndex}`;
    const prefix = `obstacle-${metadata.boxIndex}-`;
    const suffix = Math.abs(normal.x) >= Math.abs(normal.z)
      ? normal.x >= 0 ? "px" : "nx"
      : normal.z >= 0 ? "pz" : "nz";
    return `${prefix}${suffix}` as WallSurfaceId;
  }

  private createArenaWalls() {
    const half = this.level.halfSize;
    const height = this.level.arenaWallHeight;
    const thickness = 0.2;
    const walls = [
      { id: "arena-east", x: half + thickness / 2, z: 0, width: thickness, depth: half * 2 },
      { id: "arena-west", x: -half - thickness / 2, z: 0, width: thickness, depth: half * 2 },
      { id: "arena-north", x: 0, z: half + thickness / 2, width: half * 2, depth: thickness },
      { id: "arena-south", x: 0, z: -half - thickness / 2, width: half * 2, depth: thickness }
    ] as const;
    walls.forEach((wall) => {
      const collider = this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(wall.width / 2, height / 2, wall.depth / 2)
          .setTranslation(wall.x, height / 2, wall.z)
      );
      this.metadata.set(collider.handle, { kind: "arena", surfaceId: wall.id });
    });
  }
}
