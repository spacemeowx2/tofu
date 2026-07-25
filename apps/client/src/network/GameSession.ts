import {
  PROTOCOL_VERSION,
  type BulletSnapshot,
  type InkTileHashDto,
  type PeerPacket,
  type PlayerSnapshot
} from "@tofu/protocol";
import type { InkTileSnapshot } from "@tofu/simulation/ink";
import type { DamageResult, GameWorld, GameWorldEvent } from "@tofu/simulation/world";
import type { GameRenderer } from "../rendering/GameRenderer";
import type { GameTransport, PeerInfo, TransportSession } from "../transport";
import type { HudView } from "../ui/HudView";
import { PeerSession, type OutgoingPeerPacket } from "./PeerSession";

export type GameSessionCallbacks = {
  onLocalDamage(result: DamageResult, attackerName: string, damage: number): void;
};

export class GameSession {
  private readonly peer: PeerSession;
  private readonly roster = new Map<string, PeerInfo>();
  private readonly lastStateSequence = new Map<string, number>();
  private readonly processedHits = new Set<string>();
  private localPeerId = "";
  private rosterSignature = "";
  private callbacks?: GameSessionCallbacks;

  constructor(
    transport: GameTransport,
    private readonly contentId: string,
    private readonly world: GameWorld,
    private readonly renderer: GameRenderer,
    private readonly hud: HudView
  ) {
    this.peer = new PeerSession(transport, {
      contentId,
      levelId: world.level.id,
      physicsKind: world.physicsKind
    });
  }

  setCallbacks(callbacks: GameSessionCallbacks) {
    this.callbacks = callbacks;
  }

  async connect(name: string, stablePeerId: string): Promise<TransportSession> {
    const session = await this.peer.connect(
      name,
      stablePeerId,
      (packet) => this.handlePacket(packet),
      (peers) => this.syncRoster(peers)
    );
    this.localPeerId = session.peerId;
    this.syncRoster([...this.roster.values()]);
    return session;
  }

  get peers(): readonly PeerInfo[] {
    return [...this.roster.values()];
  }

  attachLocalPlayer(player: Readonly<PlayerSnapshot>) {
    this.localPeerId = player.id;
    this.renderer.syncPlayer(player, true);
    this.broadcastPlayerState();
    this.broadcastInkHashes();
  }

  broadcastPlayerState() {
    const player = this.world.players.get(this.localPeerId);
    if (player) this.send({ kind: "player_state", player: { ...player } });
  }

  sendShot(bullet: Readonly<BulletSnapshot>) {
    this.renderer.syncBullet(bullet);
    this.send({ kind: "shot", bullet: { ...bullet } });
  }

  publishWorldEvent(event: GameWorldEvent) {
    if (event.kind === "paint") {
      event.tiles.forEach((tile) => this.renderer.applyInkTile(tile));
      this.send({ kind: "paint", stamps: event.stamps });
      return;
    }
    if (event.kind === "hit") {
      this.send({
        kind: "hit",
        bulletId: event.bulletId,
        weaponId: event.weaponId,
        targetId: event.targetId,
        damage: event.damage
      });
      this.hud.addFeed(
        `你命中 ${this.world.players.get(event.targetId)?.name ?? "对手"}，造成 ${event.damage} 点伤害`
      );
      return;
    }
    this.send({ kind: "bullet_removed", bulletId: event.bulletId });
    this.renderer.removeBullet(event.bulletId);
  }

  broadcastDirtyInkTiles() {
    for (const tile of this.world.takeDirtyInkTiles()) this.send({ kind: "ink_tile", tile });
  }

  broadcastInkHashes() {
    const hashes = this.world.inkHashes();
    for (let index = 0; index < hashes.length; index += 24) {
      this.send({ kind: "ink_hashes", hashes: hashes.slice(index, index + 24) });
    }
  }

  close() {
    return this.peer.close();
  }

  private syncRoster(nextPeers: PeerInfo[]) {
    const nextSignature = nextPeers.map((peer) => peer.id).sort().join("|");
    const changed = nextSignature !== this.rosterSignature;
    this.rosterSignature = nextSignature;
    this.roster.clear();
    nextPeers.forEach((peer) => this.roster.set(peer.id, peer));
    for (const id of this.world.players.keys()) {
      if (id !== this.localPeerId && !this.roster.has(id)) {
        this.world.removePlayer(id);
        this.renderer.removePlayer(id);
        this.lastStateSequence.delete(id);
      }
    }
    this.renderHud();
    if (this.world.players.has(this.localPeerId)) {
      this.broadcastPlayerState();
      if (changed) this.broadcastInkHashes();
    }
  }

  private handlePacket(packet: PeerPacket) {
    if (
      packet.protocolVersion !== PROTOCOL_VERSION ||
      packet.contentId !== this.contentId ||
      packet.levelId !== this.world.level.id ||
      packet.physicsKind !== this.world.physicsKind ||
      packet.peerId === this.localPeerId
    ) return;
    if (packet.kind === "player_state") {
      if (
        packet.player.id !== packet.peerId ||
        packet.sequence <= (this.lastStateSequence.get(packet.peerId) ?? -1) ||
        packet.player.team !== this.roster.get(packet.peerId)?.team ||
        !this.world.hasWeapon(packet.player.weaponId)
      ) return;
      this.lastStateSequence.set(packet.peerId, packet.sequence);
      const snapshot = this.world.upsertPlayer(packet.player);
      this.renderer.syncPlayer(snapshot, false);
      this.renderHud();
      return;
    }
    if (packet.kind === "shot") {
      if (
        packet.bullet.ownerId !== packet.peerId ||
        this.world.bullets.has(packet.bullet.id) ||
        !this.world.hasWeapon(packet.bullet.weaponId) ||
        !this.world.addBullet(packet.bullet)
      ) return;
      this.renderer.syncBullet(packet.bullet);
      return;
    }
    if (packet.kind === "bullet_removed") {
      this.world.removeBullet(packet.bulletId);
      this.renderer.removeBullet(packet.bulletId);
      return;
    }
    if (packet.kind === "paint") {
      if (
        packet.stamps.length > 16 ||
        packet.stamps.some((stamp) => this.roster.get(packet.peerId)?.team !== stamp.team)
      ) return;
      const tiles = this.world.applyPaint(packet.stamps, packet.simulationTick);
      tiles.forEach((tile) => this.renderer.applyInkTile(tile));
      return;
    }
    if (packet.kind === "ink_hashes") {
      this.requestDifferingTiles(packet.peerId, packet.hashes);
      return;
    }
    if (packet.kind === "ink_tile_request") {
      if (packet.targetPeerId !== this.localPeerId || packet.tiles.length > 24) return;
      for (const key of packet.tiles) {
        const tile = this.world.inkTile(key.surfaceId, key.tileX, key.tileY);
        if (tile) this.send({ kind: "ink_tile", targetPeerId: packet.peerId, tile });
      }
      return;
    }
    if (packet.kind === "ink_tile") {
      if (packet.targetPeerId && packet.targetPeerId !== this.localPeerId) return;
      const tile = packet.tile as InkTileSnapshot;
      if (
        !Array.isArray(tile.owners) ||
        !Array.isArray(tile.ticks) ||
        !Array.isArray(tile.writers) ||
        tile.owners.length > 256 ||
        tile.ticks.length > 256 ||
        tile.writers.length > 256
      ) return;
      const authoritative = this.world.applyInkTile(tile);
      if (authoritative) this.renderer.applyInkTile(authoritative);
      return;
    }
    if (packet.kind === "hit" && packet.targetId === this.localPeerId) {
      const hitKey = `${packet.peerId}:${packet.bulletId}`;
      const attacker = this.world.players.get(packet.peerId);
      const weapon = this.world.hasWeapon(packet.weaponId)
        ? this.world.weaponFor(packet.weaponId)
        : undefined;
      if (
        this.processedHits.has(hitKey) ||
        !attacker ||
        !weapon ||
        packet.damage !== weapon.damage
      ) return;
      this.processedHits.add(hitKey);
      const result = this.world.applyDamage(this.localPeerId, packet.damage);
      if (!result) return;
      this.world.removeBullet(packet.bulletId);
      this.renderer.removeBullet(packet.bulletId);
      this.renderer.syncPlayer(result.player, true);
      this.callbacks?.onLocalDamage(result, attacker.name, packet.damage);
      this.broadcastPlayerState();
      this.renderHud();
    }
  }

  private requestDifferingTiles(peerId: string, hashes: readonly InkTileHashDto[]) {
    if (hashes.length > 24) return;
    const tiles = this.world.differingInkTiles(hashes).slice(0, 24);
    if (tiles.length > 0) this.send({ kind: "ink_tile_request", targetPeerId: peerId, tiles });
  }

  private send(payload: OutgoingPeerPacket) {
    if (!this.localPeerId) return;
    this.peer.setSimulationTick(this.world.tick);
    this.peer.send(payload);
  }

  private renderHud() {
    this.hud.renderPlayers(this.world.players.values(), this.localPeerId);
  }
}
