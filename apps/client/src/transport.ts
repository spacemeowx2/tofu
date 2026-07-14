import { ColyseusSDK, type Room } from "@colyseus/sdk";
import { ROOM_NAME, type PeerPacket, type RelayedPeerPacket, type TeamId } from "@tofu/protocol";

export type PeerInfo = { id: string; name: string; team: TeamId };
export type TransportSession = {
  peerId: string;
  roomId: string;
  team: TeamId;
  coordinatorId: string;
  epoch: number;
};

export interface GameTransport {
  connect(name: string, peerId: string): Promise<TransportSession>;
  send(packet: PeerPacket): void;
  onPacket(listener: (packet: PeerPacket) => void): () => void;
  onPeersChanged(listener: (peers: PeerInfo[]) => void): () => void;
  close(): Promise<void>;
}

type PeerMap = { forEach(callback: (peer: PeerInfo, id: string) => void): void; get(id: string): PeerInfo | undefined };
type LobbyView = { peers: PeerMap; coordinatorId: string; epoch: number };

export class ColyseusRelayTransport implements GameTransport {
  private room?: Room;
  private packetListeners = new Set<(packet: PeerPacket) => void>();
  private peerListeners = new Set<(peers: PeerInfo[]) => void>();

  constructor(private readonly endpoint: string) {}

  async connect(name: string, peerId: string): Promise<TransportSession> {
    const client = new ColyseusSDK(this.endpoint);
    const room = await client.joinOrCreate(ROOM_NAME, { name, peerId });
    this.room = room;
    room.onMessage<RelayedPeerPacket>("peer_packet", ({ from, packet }) => {
      if (from !== packet.peerId) return;
      this.packetListeners.forEach((listener) => listener(packet));
    });
    let resolveInitialState: ((state: LobbyView) => void) | undefined;
    const initialState = new Promise<LobbyView>((resolve, reject) => {
      resolveInitialState = resolve;
      window.setTimeout(() => reject(new Error("Timed out waiting for the peer roster")), 3000);
    });
    room.onStateChange((rawState) => {
      const state = rawState as LobbyView;
      this.emitPeers(state);
      if (state.peers?.get(peerId)) resolveInitialState?.(state);
    });
    const immediateState = room.state as LobbyView;
    this.emitPeers(immediateState);
    if (immediateState?.peers?.get(peerId)) resolveInitialState?.(immediateState);
    const state = await initialState;
    const localPeer = state.peers.get(peerId);
    if (!localPeer) throw new Error("Relay joined without a peer roster entry");
    return {
      peerId,
      roomId: room.roomId,
      team: localPeer.team,
      coordinatorId: state.coordinatorId,
      epoch: state.epoch
    };
  }

  send(packet: PeerPacket) {
    this.room?.send("peer_packet", packet);
  }

  onPacket(listener: (packet: PeerPacket) => void) {
    this.packetListeners.add(listener);
    return () => this.packetListeners.delete(listener);
  }

  onPeersChanged(listener: (peers: PeerInfo[]) => void) {
    this.peerListeners.add(listener);
    if (this.room) this.emitPeers(this.room.state as LobbyView);
    return () => this.peerListeners.delete(listener);
  }

  async close() {
    await this.room?.leave();
    this.room = undefined;
  }

  private emitPeers(state: LobbyView) {
    if (!state?.peers) return;
    const peers: PeerInfo[] = [];
    state.peers.forEach((peer, id) => peers.push({ id, name: peer.name, team: peer.team }));
    this.peerListeners.forEach((listener) => listener(peers));
  }
}
