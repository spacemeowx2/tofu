import { Client, Room } from "@colyseus/core";
import { PROTOCOL_VERSION, type PeerPacket, type RelayedPeerPacket } from "@tofu/protocol";
import { LobbyState, PeerState } from "./schema.js";

const MAX_PACKET_BYTES = 16 * 1024;

export class ArenaRoom extends Room<{ state: LobbyState }> {
  state = new LobbyState();
  maxClients = 8;
  private connectionPeerIds = new Map<string, string>();
  private peerClients = new Map<string, Client>();
  private assignments = new Map<string, { name: string; team: 0 | 1 }>();

  onCreate() {
    this.onMessage("peer_packet", (client, packet: PeerPacket) => this.relayPeerPacket(client, packet));
  }

  onJoin(client: Client, options: { name?: string; peerId?: string }) {
    const peerId = this.cleanPeerId(options.peerId, client.sessionId);
    const previousClient = this.peerClients.get(peerId);
    if (previousClient && previousClient !== client) {
      this.connectionPeerIds.delete(previousClient.sessionId);
      previousClient.leave(4001, "replaced by reconnect");
    }

    let assignment = this.assignments.get(peerId);
    if (!assignment) {
      let orangePlayers = 0;
      let cyanPlayers = 0;
      this.assignments.forEach((candidate) => candidate.team === 0 ? orangePlayers += 1 : cyanPlayers += 1);
      assignment = {
        name: this.cleanName(options.name),
        team: orangePlayers <= cyanPlayers ? 0 : 1
      };
      this.assignments.set(peerId, assignment);
    }

    const peer = new PeerState();
    peer.id = peerId;
    peer.name = assignment.name;
    peer.team = assignment.team;
    this.state.peers.set(peerId, peer);
    this.connectionPeerIds.set(client.sessionId, peerId);
    this.peerClients.set(peerId, client);

    if (!this.state.coordinatorId) this.state.coordinatorId = peerId;
  }

  onLeave(client: Client) {
    const peerId = this.connectionPeerIds.get(client.sessionId);
    this.connectionPeerIds.delete(client.sessionId);
    if (!peerId || this.peerClients.get(peerId) !== client) return;
    this.peerClients.delete(peerId);
    this.state.peers.delete(peerId);
    if (this.state.coordinatorId === peerId) {
      this.state.coordinatorId = [...this.state.peers.keys()].sort()[0] ?? "";
      this.state.epoch += 1;
    }
  }

  private relayPeerPacket(client: Client, packet: PeerPacket) {
    const peerId = this.connectionPeerIds.get(client.sessionId);
    if (!peerId || !packet || packet.protocolVersion !== PROTOCOL_VERSION || packet.peerId !== peerId) return;
    if (JSON.stringify(packet).length > MAX_PACKET_BYTES) return;
    const relayed: RelayedPeerPacket = { from: peerId, packet };
    this.broadcast("peer_packet", relayed, { except: client });
  }

  private cleanName(name?: string) {
    const clean = String(name ?? "").replace(/[^\p{L}\p{N}_\- ]/gu, "").trim().slice(0, 16);
    return clean || `豆腐${this.state.peers.size + 1}`;
  }

  private cleanPeerId(peerId: string | undefined, fallback: string) {
    const clean = String(peerId ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
    return clean || fallback;
  }
}
