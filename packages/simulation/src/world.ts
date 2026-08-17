import {
  PLAYER_MAX_HP,
  type BulletSnapshot,
  type PaintSurfaceId,
  type PaintStamp,
  type PlayerSnapshot,
  type TeamId,
  type WeaponId
} from "@tofu/protocol";
import {
  DEFAULT_INK_RESOLUTION,
  DEFAULT_INK_TILE_SIZE,
  MAX_INK_REVISION,
  TiledInkField,
  type InkFieldSnapshot,
  type InkTileHash,
  type InkTileSnapshot
} from "./ink.js";
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

export type PlayerRuntimeSnapshot = {
  playerId: string;
  teamSlot: number;
  bulletSequence: number;
  firing: boolean;
  fireCooldown: number;
  respawnRemaining: number;
};

export type GameWorldSnapshot = {
  version: 4;
  tick: number;
  inkRevision: number;
  levelId: string;
  physicsKind: PhysicsAdapter["kind"];
  players: PlayerSnapshot[];
  playerRuntime: PlayerRuntimeSnapshot[];
  bullets: BulletSnapshot[];
  ink: InkFieldSnapshot;
};

export type GameWorldEvent =
  | { kind: "paint"; ownerId: string; inkRevision: number; stamps: PaintStamp[]; tiles: InkTileSnapshot[] }
  | { kind: "shot"; ownerId: string; bullet: BulletSnapshot }
  | { kind: "respawn"; ownerId: string }
  | { kind: "bullet_removed"; ownerId: string; bulletId: string }
  | { kind: "hit"; ownerId: string; bulletId: string; weaponId: WeaponId; targetId: string; damage: number };

export type DamageResult = {
  player: Readonly<PlayerSnapshot>;
  defeated: boolean;
};

export type PlayerCommand = {
  playerId: string;
  input?: PlayerInput;
};

export type InkFieldView = Pick<
  TiledInkField,
  "teamAt" | "teamAtWall" | "tileHashes" | "snapshotTile"
>;

const RESPAWN_SECONDS = 2.5;

export class GameWorld {
  private readonly playerStates = new Map<string, PlayerSnapshot>();
  private readonly playerRuntime = new Map<string, PlayerRuntimeSnapshot>();
  private readonly bulletStates = new Map<string, BulletSnapshot>();
  private readonly inkField: TiledInkField;
  private readonly wallSurfaces: readonly WallSurface[];
  private currentTick = 0;
  private currentInkRevision = 0;

  constructor(
    readonly level: LevelDefinition,
    private readonly physics: PhysicsAdapter,
    private readonly weapons: WeaponCatalog = DEFAULT_WEAPONS,
    inkResolution = DEFAULT_INK_RESOLUTION,
    inkTileSize = DEFAULT_INK_TILE_SIZE
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

  get inkRevision() {
    return this.currentInkRevision;
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

  observeInkRevision(revision: number) {
    if (!Number.isSafeInteger(revision) || revision < 0 || revision > MAX_INK_REVISION) return false;
    this.currentInkRevision = Math.max(this.currentInkRevision, revision);
    return true;
  }

  isValidPaintStamp(value: unknown): value is PaintStamp {
    if (!isRecord(value)) return false;
    const candidate = value as Partial<PaintStamp>;
    const numbers = [
      candidate.originX,
      candidate.originY,
      candidate.originZ,
      candidate.x,
      candidate.y,
      candidate.z,
      candidate.radiusU,
      candidate.radiusV,
      candidate.rotation
    ];
    if (!numbers.every((number) => typeof number === "number" && Number.isFinite(number))) return false;
    const stamp = value as PaintStamp;
    const margin = 4;
    const maxHeight = Math.max(
      this.level.arenaWallHeight,
      ...this.level.obstacles.map(({ height }) => height)
    ) + margin;
    return (
      typeof stamp.id === "string" &&
      stamp.id.length > 0 &&
      stamp.id.length <= 160 &&
      (stamp.team === 0 || stamp.team === 1) &&
      (stamp.kind === "impact" || stamp.kind === "trail" || stamp.kind === "foot") &&
      (stamp.surfaceId === "ground" || this.wallSurfaces.some(({ id }) => id === stamp.surfaceId)) &&
      stamp.radiusU > 0 && stamp.radiusU <= margin &&
      stamp.radiusV > 0 && stamp.radiusV <= margin &&
      Math.abs(stamp.rotation) <= Math.PI * 4 &&
      Math.abs(stamp.x) <= this.level.halfSize + margin &&
      Math.abs(stamp.z) <= this.level.halfSize + margin &&
      Math.abs(stamp.originX) <= this.level.halfSize + margin &&
      Math.abs(stamp.originZ) <= this.level.halfSize + margin &&
      stamp.y >= -margin && stamp.y <= maxHeight &&
      stamp.originY >= -margin && stamp.originY <= maxHeight
    );
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
    this.playerRuntime.set(id, {
      playerId: id,
      teamSlot,
      bulletSequence: 0,
      firing: false,
      fireCooldown: 0,
      respawnRemaining: 0
    });
    return player;
  }

  upsertPlayer(snapshot: PlayerSnapshot): Readonly<PlayerSnapshot> {
    this.weapons.get(snapshot.weaponId);
    const existing = this.playerStates.get(snapshot.id);
    if (existing) Object.assign(existing, snapshot);
    else {
      this.playerStates.set(snapshot.id, { ...snapshot });
      this.ensurePlayerRuntime(snapshot.id);
    }
    return this.playerStates.get(snapshot.id)!;
  }

  removePlayer(id: string) {
    this.playerRuntime.delete(id);
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

  respawnPlayer(playerId: string, teamSlot?: number): Readonly<PlayerSnapshot> | undefined {
    const player = this.playerStates.get(playerId);
    if (!player) return undefined;
    const runtime = this.ensurePlayerRuntime(playerId);
    if (teamSlot !== undefined) runtime.teamSlot = teamSlot;
    const fresh = createPlayerState(
      player.id,
      player.name,
      player.team,
      player.weaponId,
      runtime.teamSlot,
      this.level
    );
    Object.assign(player, fresh);
    runtime.firing = false;
    runtime.fireCooldown = 0;
    runtime.respawnRemaining = 0;
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
      const runtime = this.ensurePlayerRuntime(playerId);
      runtime.firing = false;
      runtime.respawnRemaining = RESPAWN_SECONDS;
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
      const tiles = this.applyPaint(stamps);
      events.push({ kind: "paint", ownerId: playerId, inkRevision: this.currentInkRevision, stamps, tiles });
    }
    return { bullet: { ...bullet }, events };
  }

  step(commands: readonly PlayerCommand[], dt: number): GameWorldEvent[] {
    const commandByPlayer = new Map(commands.map(({ playerId, input }) => [playerId, input]));
    const authority = new Set(commandByPlayer.keys());
    const events: GameWorldEvent[] = [];
    commandByPlayer.forEach((input, playerId) => {
      const player = this.playerStates.get(playerId);
      if (!player) return;
      const runtime = this.ensurePlayerRuntime(playerId);
      runtime.fireCooldown -= dt;
      if (!player.alive) {
        runtime.firing = false;
        runtime.fireCooldown = Math.max(0, runtime.fireCooldown);
        runtime.respawnRemaining = Math.max(0, runtime.respawnRemaining - dt);
        if (runtime.respawnRemaining === 0 && this.respawnPlayer(playerId)) {
          events.push({ kind: "respawn", ownerId: playerId });
        }
        return;
      }
      if (!input) {
        runtime.firing = false;
        runtime.fireCooldown = Math.max(0, runtime.fireCooldown);
        return;
      }
      const wallContact = this.physics.findWallContact(player);
      stepPlayerState(player, {
        ...input,
        groundTeam: this.inkField.teamAt(player.x, player.z),
        wallContact: wallContact ? {
          ...wallContact,
          team: this.inkField.teamAtWall(
            wallContact.id,
            wallContact.x,
            wallContact.y,
            wallContact.z
          )
        } : undefined
      }, dt, this.physics);
      if (!input.fire || player.diving) {
        runtime.firing = false;
        runtime.fireCooldown = Math.max(0, runtime.fireCooldown);
        return;
      }
      const { direction, forward, right } = input.fire;
      if (![direction.x, direction.y, direction.z, forward.x, forward.z, right.x, right.z].every(Number.isFinite)) {
        runtime.firing = false;
        runtime.fireCooldown = Math.max(0, runtime.fireCooldown);
        return;
      }
      const continuing = runtime.firing;
      runtime.firing = true;
      if (runtime.fireCooldown > 1e-9) return;
      const shotIndex = ++runtime.bulletSequence;
      const result = this.shoot(
        playerId,
        `${playerId}:${shotIndex}`,
        direction,
        forward,
        right,
        shotIndex
      );
      if (!result) return;
      const interval = this.weapons.get(player.weaponId).fireIntervalSeconds;
      runtime.fireCooldown = continuing ? runtime.fireCooldown + interval : interval;
      events.push({ kind: "shot", ownerId: playerId, bullet: { ...result.bullet } });
      events.push(...result.events);
    });
    for (const bullet of [...this.bulletStates.values()]) {
      const weapon = this.weapons.get(bullet.weaponId);
      const result = stepBulletState(bullet, dt, this.physics, this.level, weapon);
      if (authority.has(bullet.ownerId)) {
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
          const tiles = this.applyPaint(stamps);
          events.push({
            kind: "paint",
            ownerId: bullet.ownerId,
            inkRevision: this.currentInkRevision,
            stamps,
            tiles
          });
        });
      }
      if (!result.alive) {
        if (authority.has(bullet.ownerId) && result.paintImpact) {
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
          const tiles = this.applyPaint(stamps);
          events.push({
            kind: "paint",
            ownerId: bullet.ownerId,
            inkRevision: this.currentInkRevision,
            stamps,
            tiles
          });
        }
        this.bulletStates.delete(bullet.id);
        if (authority.has(bullet.ownerId)) {
          events.push({ kind: "bullet_removed", ownerId: bullet.ownerId, bulletId: bullet.id });
        }
        continue;
      }
      if (!authority.has(bullet.ownerId)) continue;
      const target = [...this.playerStates.values()].find(
        (player) =>
          player.id !== bullet.ownerId &&
          player.team !== bullet.team &&
          player.alive &&
          bulletHitsPlayer(bullet, player, this.weapons)
      );
      if (!target) continue;
      this.bulletStates.delete(bullet.id);
      events.push({
        kind: "hit",
        ownerId: bullet.ownerId,
        bulletId: bullet.id,
        weaponId: bullet.weaponId,
        targetId: target.id,
        damage: weapon.damage
      });
      events.push({ kind: "bullet_removed", ownerId: bullet.ownerId, bulletId: bullet.id });
    }
    this.currentTick += 1;
    return events;
  }

  applyPaint(stamps: readonly PaintStamp[], sourceRevision?: number) {
    const accepted = stamps.filter((stamp) => this.isValidPaintStamp(stamp));
    if (accepted.length === 0) return [];
    const revision = sourceRevision ?? this.currentInkRevision + 1;
    if (!Number.isSafeInteger(revision) || revision <= 0 || revision > MAX_INK_REVISION) return [];
    this.observeInkRevision(revision);
    const tiles = new Map<string, InkTileSnapshot>();
    accepted.forEach((stamp) => {
      this.inkField.paint(stamp, revision).forEach((tile) => {
        tiles.set(`${tile.surfaceId}:${tile.tileX}:${tile.tileY}`, tile);
      });
    });
    return [...tiles.values()];
  }

  applyInkTile(snapshot: InkTileSnapshot): InkTileSnapshot | undefined {
    if (!this.inkField.applyTileSnapshot(snapshot)) return undefined;
    this.observeInkRevision(Math.max(...snapshot.ticks));
    return this.inkField.snapshotTile(snapshot.surfaceId, snapshot.tileX, snapshot.tileY);
  }

  inkHashes(): readonly InkTileHash[] {
    return this.inkField.tileHashes();
  }

  differingInkTiles(remote: readonly unknown[]) {
    const differing: Array<Pick<InkTileHash, "surfaceId" | "tileX" | "tileY">> = [];
    for (const value of remote) {
      if (!isRecord(value)) return undefined;
      const { surfaceId, tileX, tileY, hash } = value;
      if (
        typeof surfaceId !== "string" ||
        !Number.isSafeInteger(tileX) ||
        !Number.isSafeInteger(tileY) ||
        !Number.isSafeInteger(hash) ||
        (hash as number) < 0 ||
        (hash as number) > 0xffff_ffff
      ) return undefined;
      const localHash = this.inkField.tileHash(
        surfaceId as PaintSurfaceId,
        tileX as number,
        tileY as number
      );
      if (localHash === undefined) return undefined;
      if (localHash !== hash) {
        differing.push({
          surfaceId: surfaceId as PaintSurfaceId,
          tileX: tileX as number,
          tileY: tileY as number
        });
      }
    }
    return differing;
  }

  takeDirtyInkTiles() {
    return this.inkField.takeDirtyTileSnapshots();
  }

  inkTile(surfaceId: InkTileSnapshot["surfaceId"], tileX: number, tileY: number) {
    return this.inkField.snapshotTile(surfaceId, tileX, tileY);
  }

  snapshot(): GameWorldSnapshot {
    return {
      version: 4,
      tick: this.currentTick,
      inkRevision: this.currentInkRevision,
      levelId: this.level.id,
      physicsKind: this.physics.kind,
      players: [...this.playerStates.values()].map((player) => ({ ...player })),
      playerRuntime: [...this.playerRuntime.values()].map((state) => ({ ...state })),
      bullets: [...this.bulletStates.values()].map((bullet) => ({ ...bullet })),
      ink: this.inkField.snapshot()
    };
  }

  restore(snapshot: GameWorldSnapshot) {
    if (
      snapshot.version !== 4 ||
      !Number.isSafeInteger(snapshot.inkRevision) ||
      snapshot.inkRevision < 0 ||
      snapshot.inkRevision > MAX_INK_REVISION ||
      snapshot.levelId !== this.level.id ||
      snapshot.physicsKind !== this.physics.kind
    ) {
      throw new Error("Incompatible game-world snapshot");
    }
    snapshot.players.forEach((player) => this.weapons.get(player.weaponId));
    snapshot.bullets.forEach((bullet) => this.weapons.get(bullet.weaponId));
    const runtimeIds = new Set(snapshot.playerRuntime.map(({ playerId }) => playerId));
    if (
      snapshot.playerRuntime.length !== snapshot.players.length ||
      runtimeIds.size !== snapshot.players.length ||
      snapshot.players.some(({ id }) => !runtimeIds.has(id)) ||
      snapshot.playerRuntime.some((state) =>
        !Number.isSafeInteger(state.teamSlot) ||
        state.teamSlot < 0 ||
        !Number.isSafeInteger(state.bulletSequence) ||
        state.bulletSequence < 0 ||
        typeof state.firing !== "boolean" ||
        !Number.isFinite(state.fireCooldown) ||
        state.fireCooldown < 0 ||
        !Number.isFinite(state.respawnRemaining) ||
        state.respawnRemaining < 0
      )
    ) throw new Error("Invalid player runtime snapshot");
    this.currentTick = snapshot.tick;
    this.currentInkRevision = snapshot.inkRevision;
    this.playerStates.clear();
    snapshot.players.forEach((player) => this.playerStates.set(player.id, { ...player }));
    this.playerRuntime.clear();
    snapshot.playerRuntime.forEach((state) => this.playerRuntime.set(state.playerId, { ...state }));
    this.bulletStates.clear();
    snapshot.bullets.forEach((bullet) => this.bulletStates.set(bullet.id, { ...bullet }));
    this.inkField.restore(snapshot.ink);
  }

  dispose() {
    this.physics.dispose();
  }

  private ensurePlayerRuntime(playerId: string, teamSlot = 0) {
    let runtime = this.playerRuntime.get(playerId);
    if (!runtime) {
      runtime = {
        playerId,
        teamSlot,
        bulletSequence: 0,
        firing: false,
        fireCooldown: 0,
        respawnRemaining: 0
      };
      this.playerRuntime.set(playerId, runtime);
    }
    return runtime;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
