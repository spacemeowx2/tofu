import { PROTOCOL_VERSION, type PeerPacket } from "@tofu/protocol";
import type { GameTransport, PeerInfo, TransportSession } from "../transport";

type WithoutPacketHeader<T> = T extends unknown
  ? Omit<T, "protocolVersion" | "peerId" | "sequence" | "simulationTick">
  : never;
export type OutgoingPeerPacket = WithoutPacketHeader<PeerPacket>;

export class PeerSession {
  private sequence = 0;
  private peerId = "";
  private simulationTick = 0;

  constructor(private readonly transport: GameTransport) {}

  connect(
    name: string,
    peerId: string,
    onPacket: (packet: PeerPacket) => void,
    onPeersChanged: (peers: PeerInfo[]) => void
  ): Promise<TransportSession> {
    this.peerId = peerId;
    this.transport.onPacket(onPacket);
    this.transport.onPeersChanged(onPeersChanged);
    return this.transport.connect(name, peerId);
  }

  setSimulationTick(tick: number) {
    this.simulationTick = tick;
  }

  send(payload: OutgoingPeerPacket) {
    if (!this.peerId) return;
    this.transport.send({
      ...payload,
      protocolVersion: PROTOCOL_VERSION,
      peerId: this.peerId,
      sequence: ++this.sequence,
      simulationTick: this.simulationTick
    } as PeerPacket);
  }

  close() {
    return this.transport.close();
  }
}
