import type { BulletSnapshot, PaintStamp, PlayerSnapshot, TeamId, WeaponId } from "@tofu/protocol";
import {
  bulletHitsPlayer,
  createPlayer,
  createWeaponPaintStamps,
  spawnBullet,
  stepBullet,
  stepPlayer,
  type PlayerInput
} from "./index.js";
import { TiledInkField, type InkFieldSnapshot, type InkTileSnapshot } from "./ink.js";
import { createLevelWallSurfaces, type LevelDefinition, type WallSurface } from "./level.js";
import type { PhysicsAdapter } from "./physics.js";
import { getWeaponDefinition } from "./weapons.js";

export type GameWorldSnapshot = {
  version: 1;
  tick: number;
  levelId: string;
  players: PlayerSnapshot[];
  bullets: BulletSnapshot[];
  ink: InkFieldSnapshot;
};

export type GameWorldEvent =
  | { kind: "paint"; ownerId: string; stamps: PaintStamp[] }
  | { kind: "bullet_removed"; ownerId: string; bulletId: string }
  | { kind: "hit"; ownerId: string; bulletId: string; weaponId: WeaponId; targetId: string; damage: number };

export class GameWorld {
  readonly players = new Map<string, PlayerSnapshot>();
  readonly bullets = new Map<string, BulletSnapshot>();
  readonly ink: TiledInkField;
  private readonly wallSurfaces: readonly WallSurface[];
  tick = 0;

  constructor(
    readonly level: LevelDefinition,
    private physics: PhysicsAdapter,
    inkResolution = 128,
    inkTileSize = 16
  ) {
    this.ink = new TiledInkField(level, inkResolution, inkTileSize);
    this.wallSurfaces = createLevelWallSurfaces(level);
  }

  replacePhysics(physics: PhysicsAdapter) {
    this.physics.dispose();
    this.physics = physics;
  }

  createPlayer(id: string, name: string, team: TeamId, teamSlot = 0) {
    const player = createPlayer(id, name, team, teamSlot, this.level);
    this.players.set(id, player);
    return player;
  }

  upsertPlayer(snapshot: PlayerSnapshot) {
    const existing = this.players.get(snapshot.id);
    if (existing) Object.assign(existing, snapshot);
    else this.players.set(snapshot.id, { ...snapshot });
    return this.players.get(snapshot.id)!;
  }

  removePlayer(id: string) {
    this.players.delete(id);
  }

  addBullet(snapshot: BulletSnapshot) {
    this.bullets.set(snapshot.id, { ...snapshot });
  }

  removeBullet(id: string) {
    this.bullets.delete(id);
  }

  wallContactFor(player: PlayerSnapshot) {
    return this.physics.findWallContact(player);
  }

  shoot(
    playerId: string,
    shotId: string,
    weaponId: WeaponId,
    direction: { x: number; y: number; z: number },
    forward: { x: number; z: number },
    right: { x: number; z: number },
    shotIndex: number
  ) {
    const player = this.players.get(playerId);
    if (!player?.alive || player.diving) return undefined;
    const weapon = getWeaponDefinition(weaponId);
    const bullet = spawnBullet(shotId, player, direction, forward, right, weapon);
    this.bullets.set(bullet.id, bullet);
    const events: GameWorldEvent[] = [];
    if (shotIndex % weapon.paint.footEveryShots === 0) {
      const stamps = createWeaponPaintStamps({
        id: `paint:${bullet.id}:foot`,
        team: bullet.team,
        surfaceId: "ground",
        x: player.x + forward.x * 0.32,
        y: 0,
        z: player.z + forward.z * 0.32,
        directionX: forward.x,
        directionY: 0,
        directionZ: forward.z,
        seed: bullet.seed ^ 0x85ebca6b,
        kind: "foot"
      }, weapon, this.wallSurfaces);
      this.applyPaint(stamps);
      events.push({ kind: "paint", ownerId: playerId, stamps });
    }
    return { bullet, events };
  }

  step(ownerId: string, input: PlayerInput | undefined, dt: number): GameWorldEvent[] {
    const owner = this.players.get(ownerId);
    if (owner?.alive && input) stepPlayer(owner, input, dt, this.physics);
    const events: GameWorldEvent[] = [];
    for (const bullet of [...this.bullets.values()]) {
      const weapon = getWeaponDefinition(bullet.weaponId);
      const result = stepBullet(bullet, dt, this.physics, this.level);
      if (bullet.ownerId === ownerId) {
        result.trailPaintImpacts.forEach((impact, index) => {
          const stamps = createWeaponPaintStamps({
            id: `paint:${bullet.id}:trail:${bullet.paintTrailIndex - result.trailPaintImpacts.length + index}`,
            team: bullet.team,
            ...impact,
            directionX: bullet.dx,
            directionY: bullet.dy,
            directionZ: bullet.dz,
            seed: bullet.seed ^ Math.imul(bullet.paintTrailIndex + index + 1, 0x45d9f3b),
            kind: "trail"
          }, weapon, this.wallSurfaces);
          this.applyPaint(stamps);
          events.push({ kind: "paint", ownerId, stamps });
        });
      }
      if (!result.alive) {
        if (bullet.ownerId === ownerId && result.paintImpact) {
          const stamps = createWeaponPaintStamps({
            id: `paint:${bullet.id}`,
            team: bullet.team,
            ...result.paintImpact,
            directionX: bullet.dx,
            directionY: bullet.dy,
            directionZ: bullet.dz,
            seed: bullet.seed ^ 0x9e3779b9,
            kind: "impact"
          }, weapon, this.wallSurfaces);
          this.applyPaint(stamps);
          events.push({ kind: "paint", ownerId, stamps });
        }
        this.bullets.delete(bullet.id);
        if (bullet.ownerId === ownerId) events.push({ kind: "bullet_removed", ownerId, bulletId: bullet.id });
        continue;
      }
      if (bullet.ownerId !== ownerId) continue;
      const target = [...this.players.values()].find(
        (player) => player.id !== ownerId && player.team !== bullet.team && player.alive && bulletHitsPlayer(bullet, player)
      );
      if (!target) continue;
      this.bullets.delete(bullet.id);
      events.push({
        kind: "hit",
        ownerId,
        bulletId: bullet.id,
        weaponId: bullet.weaponId,
        targetId: target.id,
        damage: getWeaponDefinition(bullet.weaponId).damage
      });
      events.push({ kind: "bullet_removed", ownerId, bulletId: bullet.id });
    }
    this.tick += 1;
    return events;
  }

  applyPaint(stamps: readonly PaintStamp[]) {
    stamps.forEach((stamp) => this.ink.paint(stamp, this.tick));
  }

  applyInkTile(snapshot: InkTileSnapshot) {
    return this.ink.applyTileSnapshot(snapshot);
  }

  snapshot(): GameWorldSnapshot {
    return {
      version: 1,
      tick: this.tick,
      levelId: this.level.id,
      players: [...this.players.values()].map((player) => ({ ...player })),
      bullets: [...this.bullets.values()].map((bullet) => ({ ...bullet })),
      ink: this.ink.snapshot()
    };
  }

  restore(snapshot: GameWorldSnapshot) {
    if (snapshot.version !== 1 || snapshot.levelId !== this.level.id) throw new Error("Incompatible game-world snapshot");
    this.tick = snapshot.tick;
    this.players.clear();
    snapshot.players.forEach((player) => this.players.set(player.id, { ...player }));
    this.bullets.clear();
    snapshot.bullets.forEach((bullet) => this.bullets.set(bullet.id, { ...bullet }));
    this.ink.restore(snapshot.ink);
  }

  dispose() {
    this.physics.dispose();
  }
}
