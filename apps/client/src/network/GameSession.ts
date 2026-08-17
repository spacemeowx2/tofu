import {
  PROTOCOL_VERSION,
  type BulletSnapshot,
  type InkTileHashDto,
  type PeerPacket,
  type PlayerSnapshot
} from "@tofu/protocol";
import { MAX_INK_REVISION, type InkTileSnapshot } from "@tofu/simulation/ink";
import type { GameWorld, GameWorldEvent } from "@tofu/simulation/world";
import type { GameRenderer } from "../rendering/GameRenderer";
import type { GameTransport, PeerInfo, TransportSession } from "../transport";
import type { HudView } from "../ui/HudView";
import { PeerSession, type OutgoingPeerPacket } from "./PeerSession";

export type GameSessionCallbacks = {
  onLocalDamage(attackerName: string, damage: number): void;
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
      if (event.tiles.length > 0) this.renderer.applyPaint(event.stamps, event.tiles);
      this.send({ kind: "paint", paintRevision: event.inkRevision, stamps: event.stamps });
      return;
    }
    if (event.kind === "shot") {
      this.sendShot(event.bullet);
      return;
    }
    if (event.kind === "respawn") {
      if (event.ownerId === this.localPeerId) this.hud.addFeed("你已重新凝固");
      this.broadcastPlayerState();
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
    if (event.kind === "bullet_removed") {
      this.send({ kind: "bullet_removed", bulletId: event.bulletId });
      this.renderer.removeBullet(event.bulletId);
    }
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
      !packet ||
      typeof packet !== "object" ||
      packet.protocolVersion !== PROTOCOL_VERSION ||
      packet.contentId !== this.contentId ||
      packet.levelId !== this.world.level.id ||
      packet.physicsKind !== this.world.physicsKind ||
      typeof packet.peerId !== "string" ||
      packet.peerId === this.localPeerId ||
      !Number.isSafeInteger(packet.sequence) ||
      packet.sequence <= 0 ||
      !Number.isSafeInteger(packet.simulationTick) ||
      packet.simulationTick < 0 ||
      !Number.isSafeInteger(packet.inkRevision) ||
      packet.inkRevision < 0 ||
      packet.inkRevision > MAX_INK_REVISION
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
        !Array.isArray(packet.stamps) ||
        packet.stamps.length > 16 ||
        !Number.isSafeInteger(packet.paintRevision) ||
        packet.paintRevision <= 0 ||
        packet.paintRevision > packet.inkRevision ||
        packet.stamps.some((stamp) =>
          !this.world.isValidPaintStamp(stamp) ||
          this.roster.get(packet.peerId)?.team !== stamp.team
        )
      ) return;
      const tiles = this.world.applyPaint(packet.stamps, packet.paintRevision);
      if (tiles.length > 0) this.renderer.applyPaint(packet.stamps, tiles);
      return;
    }
    if (packet.kind === "ink_hashes") {
      if (!Array.isArray(packet.hashes)) return;
      this.requestDifferingTiles(packet.peerId, packet.hashes);
      return;
    }
    if (packet.kind === "ink_tile_request") {
      if (
        packet.targetPeerId !== this.localPeerId ||
        !Array.isArray(packet.tiles) ||
        packet.tiles.length > 24
      ) return;
      const requestedTiles: InkTileSnapshot[] = [];
      for (const key of packet.tiles as unknown[]) {
        if (
          !isRecord(key) ||
          typeof key.surfaceId !== "string" ||
          !Number.isSafeInteger(key.tileX) ||
          !Number.isSafeInteger(key.tileY)
        ) return;
        const tile = this.world.inkTile(
          key.surfaceId as InkTileSnapshot["surfaceId"],
          key.tileX as number,
          key.tileY as number
        );
        if (!tile) return;
        requestedTiles.push(tile);
      }
      for (const tile of requestedTiles) {
        this.send({ kind: "ink_tile", targetPeerId: packet.peerId, tile });
      }
      return;
    }
    if (packet.kind === "ink_tile") {
      if (packet.targetPeerId && packet.targetPeerId !== this.localPeerId) return;
      if (!isRecord(packet.tile)) return;
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
      this.callbacks?.onLocalDamage(attacker.name, packet.damage);
      this.broadcastPlayerState();
      this.renderHud();
    }
  }

  private requestDifferingTiles(peerId: string, hashes: readonly InkTileHashDto[]) {
    if (hashes.length > 24) return;
    const tiles = this.world.differingInkTiles(hashes)?.slice(0, 24);
    if (!tiles) return;
    if (tiles.length > 0) this.send({ kind: "ink_tile_request", targetPeerId: peerId, tiles });
  }

  private send(payload: OutgoingPeerPacket) {
    if (!this.localPeerId) return;
    this.peer.setSimulationTick(this.world.tick);
    this.peer.setInkRevision(this.world.inkRevision);
    this.peer.send(payload);
  }

  private renderHud() {
    this.hud.renderPlayers(this.world.players.values(), this.localPeerId);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
