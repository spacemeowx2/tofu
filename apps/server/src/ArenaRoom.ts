import { Client, Room } from "@colyseus/core";
import {
  ARENA_HALF_SIZE,
  ARENA_OBSTACLES,
  BULLET_DAMAGE,
  PLAYER_MAX_HP,
  PLAYER_RADIUS,
  SERVER_TICK_RATE,
  type GameEvent,
  type MoveInput,
  type ShootInput
} from "@tofu/protocol";
import { ArenaState, BulletState, PlayerState } from "./schema.js";

type InputState = { x: number; z: number };

const PLAYER_SPEED = 5.5;
const BULLET_SPEED = 13;
const BULLET_LIFETIME = 2.2;
const SHOT_COOLDOWN_MS = 280;
const RESPAWN_MS = 2500;

const SPAWNS = [
  { x: -6.5, z: -6.5 },
  { x: 6.5, z: 6.5 },
  { x: -6.5, z: 6.5 },
  { x: 6.5, z: -6.5 },
  { x: -3, z: -8 },
  { x: 3, z: 8 }
];

export class ArenaRoom extends Room<{ state: ArenaState }> {
  state = new ArenaState();
  maxClients = 8;

  private inputs = new Map<string, InputState>();
  private lastShotAt = new Map<string, number>();
  private respawnAt = new Map<string, number>();
  private bulletCounter = 0;

  onCreate() {
    this.patchRate = 1000 / 20;
    this.onMessage("move", (client, message: MoveInput) => this.handleMove(client, message));
    this.onMessage("shoot", (client, message: ShootInput) => this.handleShoot(client, message));
    this.setSimulationInterval((deltaMs) => this.update(deltaMs), 1000 / SERVER_TICK_RATE);
  }

  onJoin(client: Client, options: { name?: string }) {
    const spawn = SPAWNS[this.state.players.size % SPAWNS.length];
    const player = new PlayerState();
    player.id = client.sessionId;
    player.name = this.cleanName(options.name);
    player.x = spawn.x;
    player.z = spawn.z;
    this.state.players.set(client.sessionId, player);
    this.inputs.set(client.sessionId, { x: 0, z: 0 });
    this.announce({ kind: "joined", message: `${player.name} 进入了豆腐竞技场` }, client);
  }

  onLeave(client: Client) {
    const name = this.state.players.get(client.sessionId)?.name ?? "一块豆腐";
    this.state.players.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
    this.lastShotAt.delete(client.sessionId);
    this.respawnAt.delete(client.sessionId);
    this.announce({ kind: "left", message: `${name} 离开了竞技场` });
  }

  private handleMove(client: Client, message: MoveInput) {
    if (!Number.isFinite(message?.x) || !Number.isFinite(message?.z)) return;
    const length = Math.hypot(message.x, message.z);
    this.inputs.set(client.sessionId, {
      x: length > 1 ? message.x / length : message.x,
      z: length > 1 ? message.z / length : message.z
    });
  }

  private handleShoot(client: Client, message: ShootInput) {
    const player = this.state.players.get(client.sessionId);
    if (!player?.alive || !Number.isFinite(message?.dx) || !Number.isFinite(message?.dy) || !Number.isFinite(message?.dz)) return;

    const now = Date.now();
    if (now - (this.lastShotAt.get(client.sessionId) ?? 0) < SHOT_COOLDOWN_MS) return;

    const length = Math.hypot(message.dx, message.dy, message.dz);
    if (length < 0.01) return;

    const bullet = new BulletState();
    bullet.id = `b${++this.bulletCounter}`;
    bullet.ownerId = client.sessionId;
    bullet.dx = message.dx / length;
    bullet.dy = message.dy / length;
    bullet.dz = message.dz / length;
    bullet.x = player.x + bullet.dx * 0.95;
    bullet.y = 0.85 + bullet.dy * 0.5;
    bullet.z = player.z + bullet.dz * 0.95;
    const horizontalLength = Math.hypot(bullet.dx, bullet.dz);
    if (horizontalLength > 0.01) {
      player.facingX = bullet.dx / horizontalLength;
      player.facingZ = bullet.dz / horizontalLength;
    }
    this.state.bullets.set(bullet.id, bullet);
    this.lastShotAt.set(client.sessionId, now);
  }

  private update(deltaMs: number) {
    const dt = Math.min(deltaMs / 1000, 0.05);
    this.state.tick += 1;
    this.updateRespawns();
    this.updatePlayers(dt);
    this.updateBullets(dt);
  }

  private updatePlayers(dt: number) {
    this.state.players.forEach((player, id) => {
      if (!player.alive) return;
      const input = this.inputs.get(id) ?? { x: 0, z: 0 };
      if (Math.hypot(input.x, input.z) > 0.01) {
        player.facingX = input.x;
        player.facingZ = input.z;
      }

      const nextX = this.clampArena(player.x + input.x * PLAYER_SPEED * dt);
      if (!this.hitsObstacle(nextX, player.z, PLAYER_RADIUS)) player.x = nextX;
      const nextZ = this.clampArena(player.z + input.z * PLAYER_SPEED * dt);
      if (!this.hitsObstacle(player.x, nextZ, PLAYER_RADIUS)) player.z = nextZ;
    });
  }

  private updateBullets(dt: number) {
    const remove: string[] = [];
    this.state.bullets.forEach((bullet, bulletId) => {
      bullet.age += dt;
      bullet.x += bullet.dx * BULLET_SPEED * dt;
      bullet.y += bullet.dy * BULLET_SPEED * dt;
      bullet.z += bullet.dz * BULLET_SPEED * dt;

      if (
        bullet.age >= BULLET_LIFETIME ||
        bullet.y < 0.12 ||
        bullet.y > 8 ||
        Math.abs(bullet.x) > ARENA_HALF_SIZE ||
        Math.abs(bullet.z) > ARENA_HALF_SIZE ||
        this.bulletHitsObstacle(bullet.x, bullet.y, bullet.z, 0.15)
      ) {
        remove.push(bulletId);
        return;
      }

      for (const [playerId, player] of this.state.players) {
        if (playerId === bullet.ownerId || !player.alive) continue;
        if (Math.hypot(player.x - bullet.x, 0.7 - bullet.y, player.z - bullet.z) > PLAYER_RADIUS + 0.25) continue;

        const shooter = this.state.players.get(bullet.ownerId);
        player.hp = Math.max(0, player.hp - BULLET_DAMAGE);
        this.announce({
          kind: "hit",
          message: `${shooter?.name ?? "豆腐"} 命中 ${player.name}，造成 ${BULLET_DAMAGE} 点伤害`
        });
        if (player.hp === 0) {
          player.alive = false;
          this.inputs.set(playerId, { x: 0, z: 0 });
          this.respawnAt.set(playerId, Date.now() + RESPAWN_MS);
          this.announce({ kind: "knockout", message: `${player.name} 被打散了，正在重新凝固…` });
        }
        remove.push(bulletId);
        break;
      }
    });
    remove.forEach((id) => this.state.bullets.delete(id));
  }

  private updateRespawns() {
    const now = Date.now();
    this.respawnAt.forEach((timestamp, playerId) => {
      if (timestamp > now) return;
      const player = this.state.players.get(playerId);
      if (player) {
        const spawn = SPAWNS[Math.floor(Math.random() * SPAWNS.length)];
        player.x = spawn.x;
        player.z = spawn.z;
        player.hp = PLAYER_MAX_HP;
        player.alive = true;
        this.announce({ kind: "respawn", message: `${player.name} 已重新凝固` });
      }
      this.respawnAt.delete(playerId);
    });
  }

  private hitsObstacle(x: number, z: number, radius: number) {
    return ARENA_OBSTACLES.some(
      (box) =>
        Math.abs(x - box.x) <= box.width / 2 + radius &&
        Math.abs(z - box.z) <= box.depth / 2 + radius
    );
  }

  private bulletHitsObstacle(x: number, y: number, z: number, radius: number) {
    return ARENA_OBSTACLES.some(
      (box) =>
        y <= box.height + radius &&
        Math.abs(x - box.x) <= box.width / 2 + radius &&
        Math.abs(z - box.z) <= box.depth / 2 + radius
    );
  }

  private clampArena(value: number) {
    return Math.max(-ARENA_HALF_SIZE + PLAYER_RADIUS, Math.min(ARENA_HALF_SIZE - PLAYER_RADIUS, value));
  }

  private cleanName(name?: string) {
    const clean = String(name ?? "").replace(/[^\p{L}\p{N}_\- ]/gu, "").trim().slice(0, 16);
    return clean || `豆腐${this.state.players.size + 1}`;
  }

  private announce(event: GameEvent, except?: Client) {
    this.broadcast("game_event", event, { except });
  }
}
