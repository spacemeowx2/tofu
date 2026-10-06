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
import { createLevelFloorSurfaces, createLevelWallSurfaces, type LevelDefinition, type WallSurface } from "./level.js";
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
  inkRecoveryDelay: number;
  damageRecoveryDelay: number;
};

export type TargetSnapshot = { id: string; x: number; y: number; z: number; hp: number; respawnRemaining: number };
export type InkFlowSnapshot = { ownerId: string; stamp: PaintStamp; elapsed: number; nextStep: number };

export type GameWorldSnapshot = {
  version: 5;
  tick: number;
  inkRevision: number;
  levelId: string;
  physicsKind: PhysicsAdapter["kind"];
  players: PlayerSnapshot[];
  playerRuntime: PlayerRuntimeSnapshot[];
  bullets: BulletSnapshot[];
  ink: InkFieldSnapshot;
  targets: TargetSnapshot[];
  inkFlows: InkFlowSnapshot[];
};

export type GameWorldEvent =
  | { kind: "paint"; ownerId: string; inkRevision: number; stamps: PaintStamp[]; tiles: InkTileSnapshot[] }
  | { kind: "shot"; ownerId: string; bullet: BulletSnapshot }
  | { kind: "respawn"; ownerId: string }
  | { kind: "target_hit"; ownerId: string; targetId: string; damage: number; hp: number }
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
  private readonly targetStates = new Map<string, TargetSnapshot>();
  private readonly inkFlows: InkFlowSnapshot[] = [];
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
    for (const target of level.targets ?? []) this.targetStates.set(target.id, { ...target, hp: PLAYER_MAX_HP, respawnRemaining: 0 });
  }

  get players(): ReadonlyMap<string, Readonly<PlayerSnapshot>> {
    return this.playerStates;
  }

  get bullets(): ReadonlyMap<string, Readonly<BulletSnapshot>> {
    return this.bulletStates;
  }

  get targets(): ReadonlyMap<string, Readonly<TargetSnapshot>> {
    return this.targetStates;
  }

  turfCoverage() {
    return this.inkField.coverage();
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
      (stamp.kind === "impact" || stamp.kind === "flow" || stamp.kind === "trail" || stamp.kind === "foot") &&
      (createLevelFloorSurfaces(this.level).some(({ id }) => id === stamp.surfaceId) || this.wallSurfaces.some(({ id }) => id === stamp.surfaceId)) &&
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
      respawnRemaining: 0,
      inkRecoveryDelay: 0,
      damageRecoveryDelay: 0
    });
    return player;
  }

  upsertPlayer(snapshot: PlayerSnapshot): Readonly<PlayerSnapshot> {
    if (!this.isValidPlayerSnapshot(snapshot)) throw new Error("Invalid player snapshot");
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
    this.physics.removePlayer(id);
    this.playerRuntime.delete(id);
    return this.playerStates.delete(id);
  }

  addBullet(snapshot: BulletSnapshot) {
    if (!this.isValidBulletSnapshot(snapshot)) return false;
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

  isValidPlayerSnapshot(value: unknown): value is PlayerSnapshot {
    if (!isRecord(value)) return false;
    return typeof value.id === "string" && typeof value.name === "string" && typeof value.weaponId === "string" && this.hasWeapon(value.weaponId)
      && (value.team === 0 || value.team === 1)
      && ["x", "y", "z", "vx", "vy", "vz", "facingX", "facingZ", "hp", "ink", "aimPitch"].every((key) => typeof value[key] === "number" && Number.isFinite(value[key]))
      && ["alive", "diving", "wallAttached", "grounded"].every((key) => typeof value[key] === "boolean")
      && typeof value.wallSurfaceId === "string"
      && (value.hp as number) >= 0 && (value.hp as number) <= PLAYER_MAX_HP
      && (value.ink as number) >= 0 && (value.ink as number) <= 100
      && Math.abs(value.x as number) <= this.level.halfSize + 4 && Math.abs(value.z as number) <= this.level.halfSize + 4
      && Math.abs(value.y as number) < 20 && Math.abs(value.aimPitch as number) <= Math.PI / 2;
  }

  isValidBulletSnapshot(value: unknown): value is BulletSnapshot {
    if (!isRecord(value)) return false;
    return typeof value.id === "string" && typeof value.ownerId === "string" && typeof value.weaponId === "string" && this.hasWeapon(value.weaponId)
      && (value.team === 0 || value.team === 1) && (value.kind === "shot" || value.kind === "droplet")
      && ["x", "y", "z", "dx", "dy", "dz", "age", "distanceTraveled", "paintTrailIndex", "seed"].every((key) => typeof value[key] === "number" && Number.isFinite(value[key]))
      && (value.age as number) >= 0 && (value.age as number) <= 3
      && (value.distanceTraveled as number) >= 0 && (value.distanceTraveled as number) < 100
      && Math.abs(value.x as number) <= this.level.halfSize + 4 && Math.abs(value.z as number) <= this.level.halfSize + 4
      && Math.abs(value.y as number) < 20 && Math.hypot(value.dx as number, value.dy as number, value.dz as number) < 20;
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
    runtime.inkRecoveryDelay = 0;
    runtime.damageRecoveryDelay = 0;
    return player;
  }

  applyDamage(playerId: string, damage: number): DamageResult | undefined {
    const player = this.playerStates.get(playerId);
    if (!player?.alive || !Number.isFinite(damage) || damage <= 0) return undefined;
    player.hp = Math.max(0, player.hp - damage);
    this.ensurePlayerRuntime(playerId).damageRecoveryDelay = 1.2;
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
    if (player.ink < weapon.inkCost) return undefined;
    player.ink = Math.max(0, player.ink - weapon.inkCost);
    this.ensurePlayerRuntime(playerId).inkRecoveryDelay = 20 / 60;
    const bullet = createBulletState(shotId, player, direction, forward, right, weapon);
    this.bulletStates.set(bullet.id, bullet);
    const events: GameWorldEvent[] = [];
    if (shotIndex % weapon.paint.footEveryShots === 0) {
      const stamps = createPaintStamps({
        id: `paint:${bullet.id}:foot`,
        team: bullet.team,
        surfaceId: createLevelFloorSurfaces(this.level).find((floor) => floor.id !== "ground" && Math.abs(floor.y - player.y) < 0.16 && Math.abs(player.x - floor.x) < floor.width / 2 && Math.abs(player.z - floor.z) < floor.depth / 2)?.id ?? "ground",
        x: player.x + forward.x * weapon.paint.footForwardOffset,
        y: player.y,
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
    for (const target of this.targetStates.values()) {
      if (target.respawnRemaining > 0) {
        target.respawnRemaining = Math.max(0, target.respawnRemaining - dt);
        if (target.respawnRemaining === 0) target.hp = PLAYER_MAX_HP;
      }
    }
    for (let index = this.inkFlows.length - 1; index >= 0; index--) {
      const flow = this.inkFlows[index];
      if (!authority.has(flow.ownerId)) continue;
      flow.elapsed += dt;
      if (flow.elapsed < flow.nextStep) continue;
      const amount = Math.min(1, flow.elapsed / 0.18);
      const stamp = growingStamp(flow.stamp, amount, "flow");
      const tiles = this.applyPaint([stamp]);
      events.push({ kind: "paint", ownerId: flow.ownerId, inkRevision: this.currentInkRevision, stamps: [stamp], tiles });
      flow.nextStep += 1 / 30;
      if (amount === 1) this.inkFlows.splice(index, 1);
    }
    commandByPlayer.forEach((input, playerId) => {
      const player = this.playerStates.get(playerId);
      if (!player) return;
      const runtime = this.ensurePlayerRuntime(playerId);
      runtime.fireCooldown -= dt;
      runtime.inkRecoveryDelay = Math.max(0, runtime.inkRecoveryDelay - dt);
      runtime.damageRecoveryDelay = Math.max(0, runtime.damageRecoveryDelay - dt);
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
        groundTeam: this.inkField.teamAt(player.x, player.z, player.y),
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
      if (runtime.damageRecoveryDelay === 0) player.hp = Math.min(PLAYER_MAX_HP, player.hp + 30 * dt);
      if (runtime.inkRecoveryDelay === 0 && (!input.fire || player.diving)) {
        const inOwnInk = player.wallAttached || player.diving && this.inkField.teamAt(player.x, player.z, player.y) === player.team;
        player.ink = Math.min(100, player.ink + (inOwnInk ? 30 : 9) * dt);
      }
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
      if (player.ink < this.weapons.get(player.weaponId).inkCost) {
        runtime.fireCooldown = 0;
        return;
      }
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
      const previous = { x: bullet.x, y: bullet.y, z: bullet.z };
      const weapon = this.weapons.get(bullet.weaponId);
      const result = stepBulletState(bullet, dt, this.physics, this.level, weapon);
      if (authority.has(bullet.ownerId) && bullet.kind === "shot") {
        const player = [...this.playerStates.values()].find((player) => player.id !== bullet.ownerId && player.team !== bullet.team && player.alive && bulletHitsPlayer(bullet, player, this.weapons, previous));
        const target = !player ? [...this.targetStates.values()].find((target) => target.hp > 0 && bulletHitsPlayer(bullet, { ...target, diving: false }, this.weapons, previous)) : undefined;
        if (player || target) {
          this.bulletStates.delete(bullet.id);
          if (player) events.push({ kind: "hit", ownerId: bullet.ownerId, bulletId: bullet.id, weaponId: bullet.weaponId, targetId: player.id, damage: weapon.damage });
          if (target) {
            target.hp = Math.max(0, target.hp - weapon.damage);
            if (target.hp === 0) target.respawnRemaining = 2;
            events.push({ kind: "target_hit", ownerId: bullet.ownerId, targetId: target.id, damage: weapon.damage, hp: target.hp });
          }
          events.push({ kind: "bullet_removed", ownerId: bullet.ownerId, bulletId: bullet.id });
          continue;
        }
      }
      if (authority.has(bullet.ownerId)) {
        result.trailPaintImpacts.forEach((impact, index) => {
          const droplet: BulletSnapshot = {
            ...bullet, ...impact,
            id: `${bullet.id}:drop:${bullet.paintTrailIndex - result.trailPaintImpacts.length + index}`,
            kind: "droplet", dx: bullet.dx * 0.28, dy: -0.5, dz: bullet.dz * 0.28,
            age: 0, distanceTraveled: 0, paintTrailIndex: 0
          };
          this.bulletStates.set(droplet.id, droplet);
          events.push({ kind: "shot", ownerId: bullet.ownerId, bullet: { ...droplet } });
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
            kind: bullet.kind === "droplet" ? "trail" : "impact"
          }, weapon, this.wallSurfaces);
          const growing = bullet.kind === "droplet" ? stamps : stamps.map((stamp) => growingStamp(stamp, 0, "impact"));
          if (bullet.kind === "shot") stamps.forEach((stamp) => this.inkFlows.push({ ownerId: bullet.ownerId, stamp, elapsed: 0, nextStep: 1 / 30 }));
          const tiles = this.applyPaint(growing);
          events.push({
            kind: "paint",
            ownerId: bullet.ownerId,
            inkRevision: this.currentInkRevision,
            stamps: growing,
            tiles
          });
        }
        this.bulletStates.delete(bullet.id);
        if (authority.has(bullet.ownerId)) {
          events.push({ kind: "bullet_removed", ownerId: bullet.ownerId, bulletId: bullet.id });
        }
        continue;
      }
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
      version: 5,
      tick: this.currentTick,
      inkRevision: this.currentInkRevision,
      levelId: this.level.id,
      physicsKind: this.physics.kind,
      players: [...this.playerStates.values()].map((player) => ({ ...player })),
      playerRuntime: [...this.playerRuntime.values()].map((state) => ({ ...state })),
      bullets: [...this.bulletStates.values()].map((bullet) => ({ ...bullet })),
      ink: this.inkField.snapshot(),
      targets: [...this.targetStates.values()].map((target) => ({ ...target })),
      inkFlows: this.inkFlows.map((flow) => ({ ...flow, stamp: { ...flow.stamp } }))
    };
  }

  restore(snapshot: GameWorldSnapshot) {
    if (
      snapshot.version !== 5 ||
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
        || !Number.isFinite(state.inkRecoveryDelay) || state.inkRecoveryDelay < 0
        || !Number.isFinite(state.damageRecoveryDelay) || state.damageRecoveryDelay < 0
      )
    ) throw new Error("Invalid player runtime snapshot");
    this.currentTick = snapshot.tick;
    this.currentInkRevision = snapshot.inkRevision;
    for (const id of this.playerStates.keys()) this.physics.removePlayer(id);
    this.playerStates.clear();
    snapshot.players.forEach((player) => this.playerStates.set(player.id, { ...player }));
    this.playerRuntime.clear();
    snapshot.playerRuntime.forEach((state) => this.playerRuntime.set(state.playerId, { ...state }));
    this.bulletStates.clear();
    snapshot.bullets.forEach((bullet) => this.bulletStates.set(bullet.id, { ...bullet }));
    this.targetStates.clear();
    snapshot.targets.forEach((target) => this.targetStates.set(target.id, { ...target }));
    this.inkFlows.splice(0, this.inkFlows.length, ...snapshot.inkFlows.map((flow) => ({ ...flow, stamp: { ...flow.stamp } })));
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
        respawnRemaining: 0,
        inkRecoveryDelay: 0,
        damageRecoveryDelay: 0
      };
      this.playerRuntime.set(playerId, runtime);
    }
    return runtime;
  }
}

function growingStamp(stamp: PaintStamp, progress: number, kind: PaintStamp["kind"]): PaintStamp {
  const amount = 0.42 + 0.58 * (1 - (1 - progress) ** 2);
  return {
    ...stamp, kind,
    x: stamp.originX + (stamp.x - stamp.originX) * amount,
    y: stamp.originY + (stamp.y - stamp.originY) * amount,
    z: stamp.originZ + (stamp.z - stamp.originZ) * amount,
    radiusU: stamp.radiusU * amount, radiusV: stamp.radiusV * amount
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
