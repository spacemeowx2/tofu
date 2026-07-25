import {
  PLAYER_MAX_HP,
  type BulletSnapshot,
  type PaintStamp,
  type PlayerSnapshot,
  type TeamId,
  type WeaponId
} from "@tofu/protocol";
import { TiledInkField, type InkFieldSnapshot, type InkTileHash, type InkTileSnapshot } from "./ink.js";
import { createLevelWallSurfaces, type LevelDefinition, type WallSurface } from "./level.js";
import type { PhysicsAdapter } from "./physics.js";
import {
  bulletHitsPlayer,
  createBulletState,
  createPaintStamps,
  createPlayerState,
  stepBulletState,
  stepPlayerState,
  type PlayerInput
} from "./systems.js";
import { DEFAULT_WEAPONS, type WeaponCatalog, type WeaponDefinition } from "./weapons.js";

export type { PlayerInput } from "./systems.js";

export type GameWorldSnapshot = {
  version: 2;
  tick: number;
  levelId: string;
  physicsKind: PhysicsAdapter["kind"];
  players: PlayerSnapshot[];
  bullets: BulletSnapshot[];
  ink: InkFieldSnapshot;
};

export type GameWorldEvent =
  | { kind: "paint"; ownerId: string; stamps: PaintStamp[]; tiles: InkTileSnapshot[] }
  | { kind: "bullet_removed"; ownerId: string; bulletId: string }
  | { kind: "hit"; ownerId: string; bulletId: string; weaponId: WeaponId; targetId: string; damage: number };

export type DamageResult = {
  player: Readonly<PlayerSnapshot>;
  defeated: boolean;
};

export type InkFieldView = Pick<
  TiledInkField,
  "teamAt" | "teamAtWall" | "tileHashes" | "snapshotTile"
>;

export class GameWorld {
  private readonly playerStates = new Map<string, PlayerSnapshot>();
  private readonly bulletStates = new Map<string, BulletSnapshot>();
  private readonly inkField: TiledInkField;
  private readonly wallSurfaces: readonly WallSurface[];
  private currentTick = 0;

  constructor(
    readonly level: LevelDefinition,
    private readonly physics: PhysicsAdapter,
    private readonly weapons: WeaponCatalog = DEFAULT_WEAPONS,
    inkResolution = 128,
    inkTileSize = 8
  ) {
    this.inkField = new TiledInkField(level, inkResolution, inkTileSize);
    this.wallSurfaces = createLevelWallSurfaces(level);
  }

  get players(): ReadonlyMap<string, Readonly<PlayerSnapshot>> {
    return this.playerStates;
  }

  get bullets(): ReadonlyMap<string, Readonly<BulletSnapshot>> {
    return this.bulletStates;
  }

  get physicsKind() {
    return this.physics.kind;
  }

  get tick() {
    return this.currentTick;
  }

  get ink(): InkFieldView {
    return this.inkField;
  }

  weaponFor(playerOrWeapon: PlayerSnapshot | WeaponId): WeaponDefinition {
    return this.weapons.get(typeof playerOrWeapon === "string" ? playerOrWeapon : playerOrWeapon.weaponId);
  }

  hasWeapon(weaponId: WeaponId) {
    return Boolean(this.weapons.find(weaponId));
  }

  createPlayer(
    id: string,
    name: string,
    team: TeamId,
    weaponId: WeaponId,
    teamSlot = 0
  ): Readonly<PlayerSnapshot> {
    this.weapons.get(weaponId);
    const player = createPlayerState(id, name, team, weaponId, teamSlot, this.level);
    this.playerStates.set(id, player);
    return player;
  }

  upsertPlayer(snapshot: PlayerSnapshot): Readonly<PlayerSnapshot> {
    this.weapons.get(snapshot.weaponId);
    const existing = this.playerStates.get(snapshot.id);
    if (existing) Object.assign(existing, snapshot);
    else this.playerStates.set(snapshot.id, { ...snapshot });
    return this.playerStates.get(snapshot.id)!;
  }

  removePlayer(id: string) {
    return this.playerStates.delete(id);
  }

  addBullet(snapshot: BulletSnapshot) {
    this.weapons.get(snapshot.weaponId);
    const owner = this.playerStates.get(snapshot.ownerId);
    if (
      !owner ||
      snapshot.team !== owner.team ||
      snapshot.weaponId !== owner.weaponId
    ) return false;
    this.bulletStates.set(snapshot.id, { ...snapshot });
    return true;
  }

  removeBullet(id: string) {
    return this.bulletStates.delete(id);
  }

  wallContactFor(playerId: string) {
    const player = this.playerStates.get(playerId);
    return player ? this.physics.findWallContact(player) : undefined;
  }

  respawnPlayer(playerId: string, teamSlot = 0): Readonly<PlayerSnapshot> | undefined {
    const player = this.playerStates.get(playerId);
    if (!player) return undefined;
    const fresh = createPlayerState(
      player.id,
      player.name,
      player.team,
      player.weaponId,
      teamSlot,
      this.level
    );
    Object.assign(player, fresh);
    return player;
  }

  applyDamage(playerId: string, damage: number): DamageResult | undefined {
    const player = this.playerStates.get(playerId);
    if (!player?.alive || !Number.isFinite(damage) || damage <= 0) return undefined;
    player.hp = Math.max(0, player.hp - damage);
    const defeated = player.hp === 0;
    if (defeated) {
      player.alive = false;
      player.vx = 0;
      player.vy = 0;
      player.vz = 0;
      player.diving = false;
      player.wallAttached = false;
      player.wallSurfaceId = "";
    }
    return { player, defeated };
  }

  shoot(
    playerId: string,
    shotId: string,
    direction: { x: number; y: number; z: number },
    forward: { x: number; z: number },
    right: { x: number; z: number },
    shotIndex: number
  ): { bullet: Readonly<BulletSnapshot>; events: readonly GameWorldEvent[] } | undefined {
    const player = this.playerStates.get(playerId);
    if (!player?.alive || player.diving) return undefined;
    const weapon = this.weapons.get(player.weaponId);
    const bullet = createBulletState(shotId, player, direction, forward, right, weapon);
    this.bulletStates.set(bullet.id, bullet);
    const events: GameWorldEvent[] = [];
    if (shotIndex % weapon.paint.footEveryShots === 0) {
      const stamps = createPaintStamps({
        id: `paint:${bullet.id}:foot`,
        team: bullet.team,
        surfaceId: "ground",
        x: player.x + forward.x * weapon.paint.footForwardOffset,
        y: 0,
        z: player.z + forward.z * weapon.paint.footForwardOffset,
        directionX: forward.x,
        directionY: 0,
        directionZ: forward.z,
        seed: bullet.seed ^ 0x85ebca6b,
        kind: "foot"
      }, weapon, this.wallSurfaces);
      const tiles = this.applyPaint(stamps, this.currentTick);
      events.push({ kind: "paint", ownerId: playerId, stamps, tiles });
    }
    return { bullet: { ...bullet }, events };
  }

  step(ownerId: string, input: PlayerInput | undefined, dt: number): GameWorldEvent[] {
    const owner = this.playerStates.get(ownerId);
    if (owner?.alive && input) stepPlayerState(owner, input, dt, this.physics);
    const events: GameWorldEvent[] = [];
    for (const bullet of [...this.bulletStates.values()]) {
      const weapon = this.weapons.get(bullet.weaponId);
      const result = stepBulletState(bullet, dt, this.physics, this.level, weapon);
      if (bullet.ownerId === ownerId) {
        result.trailPaintImpacts.forEach((impact, index) => {
          const stamps = createPaintStamps({
            id: `paint:${bullet.id}:trail:${bullet.paintTrailIndex - result.trailPaintImpacts.length + index}`,
            team: bullet.team,
            ...impact,
            directionX: bullet.dx,
            directionY: bullet.dy,
            directionZ: bullet.dz,
            seed: bullet.seed ^ Math.imul(bullet.paintTrailIndex + index + 1, 0x45d9f3b),
            kind: "trail"
          }, weapon, this.wallSurfaces);
          const tiles = this.applyPaint(stamps, this.currentTick);
          events.push({ kind: "paint", ownerId, stamps, tiles });
        });
      }
      if (!result.alive) {
        if (bullet.ownerId === ownerId && result.paintImpact) {
          const stamps = createPaintStamps({
            id: `paint:${bullet.id}`,
            team: bullet.team,
            ...result.paintImpact,
            directionX: bullet.dx,
            directionY: bullet.dy,
            directionZ: bullet.dz,
            seed: bullet.seed ^ 0x9e3779b9,
            kind: "impact"
          }, weapon, this.wallSurfaces);
          const tiles = this.applyPaint(stamps, this.currentTick);
          events.push({ kind: "paint", ownerId, stamps, tiles });
        }
        this.bulletStates.delete(bullet.id);
        if (bullet.ownerId === ownerId) events.push({ kind: "bullet_removed", ownerId, bulletId: bullet.id });
        continue;
      }
      if (bullet.ownerId !== ownerId) continue;
      const target = [...this.playerStates.values()].find(
        (player) =>
          player.id !== ownerId &&
          player.team !== bullet.team &&
          player.alive &&
          bulletHitsPlayer(bullet, player, this.weapons)
      );
      if (!target) continue;
      this.bulletStates.delete(bullet.id);
      events.push({
        kind: "hit",
        ownerId,
        bulletId: bullet.id,
        weaponId: bullet.weaponId,
        targetId: target.id,
        damage: weapon.damage
      });
      events.push({ kind: "bullet_removed", ownerId, bulletId: bullet.id });
    }
    this.currentTick += 1;
    return events;
  }

  applyPaint(stamps: readonly PaintStamp[], sourceTick = this.currentTick) {
    const tiles = new Map<string, InkTileSnapshot>();
    stamps.forEach((stamp) => {
      this.inkField.paint(stamp, sourceTick).forEach((tile) => {
        tiles.set(`${tile.surfaceId}:${tile.tileX}:${tile.tileY}`, tile);
      });
    });
    return [...tiles.values()];
  }

  applyInkTile(snapshot: InkTileSnapshot): InkTileSnapshot | undefined {
    if (!this.inkField.applyTileSnapshot(snapshot)) return undefined;
    return this.inkField.snapshotTile(snapshot.surfaceId, snapshot.tileX, snapshot.tileY);
  }

  inkHashes(): readonly InkTileHash[] {
    return this.inkField.tileHashes();
  }

  differingInkTiles(remote: readonly InkTileHash[]) {
    const local = new Map(
      this.inkField.tileHashes().map((entry) => [`${entry.surfaceId}:${entry.tileX}:${entry.tileY}`, entry.hash])
    );
    return remote
      .filter((entry) => local.get(`${entry.surfaceId}:${entry.tileX}:${entry.tileY}`) !== entry.hash)
      .map(({ surfaceId, tileX, tileY }) => ({ surfaceId, tileX, tileY }));
  }

  takeDirtyInkTiles() {
    return this.inkField.takeDirtyTileSnapshots();
  }

  inkTile(surfaceId: InkTileSnapshot["surfaceId"], tileX: number, tileY: number) {
    return this.inkField.snapshotTile(surfaceId, tileX, tileY);
  }

  snapshot(): GameWorldSnapshot {
    return {
      version: 2,
      tick: this.currentTick,
      levelId: this.level.id,
      physicsKind: this.physics.kind,
      players: [...this.playerStates.values()].map((player) => ({ ...player })),
      bullets: [...this.bulletStates.values()].map((bullet) => ({ ...bullet })),
      ink: this.inkField.snapshot()
    };
  }

  restore(snapshot: GameWorldSnapshot) {
    if (
      snapshot.version !== 2 ||
      snapshot.levelId !== this.level.id ||
      snapshot.physicsKind !== this.physics.kind
    ) {
      throw new Error("Incompatible game-world snapshot");
    }
    snapshot.players.forEach((player) => this.weapons.get(player.weaponId));
    snapshot.bullets.forEach((bullet) => this.weapons.get(bullet.weaponId));
    this.currentTick = snapshot.tick;
    this.playerStates.clear();
    snapshot.players.forEach((player) => this.playerStates.set(player.id, { ...player }));
    this.bulletStates.clear();
    snapshot.bullets.forEach((bullet) => this.bulletStates.set(bullet.id, { ...bullet }));
    this.inkField.restore(snapshot.ink);
  }

  dispose() {
    this.physics.dispose();
  }
}
