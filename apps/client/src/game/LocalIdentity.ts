import type { PlayerSnapshot, TeamId } from "@tofu/protocol";

const PEER_ID_STORAGE_KEY = "tofu.peerId";
const PLAYER_STATE_STORAGE_KEY = "tofu.playerState";

export class LocalIdentity {
  peerId() {
    const existing = sessionStorage.getItem(PEER_ID_STORAGE_KEY);
    if (existing) return existing;
    const generated = globalThis.crypto?.randomUUID?.() ??
      `peer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(PEER_ID_STORAGE_KEY, generated);
    return generated;
  }

  save(roomId: string, player: Readonly<PlayerSnapshot>) {
    sessionStorage.setItem(PLAYER_STATE_STORAGE_KEY, JSON.stringify({ roomId, player }));
  }

  restore(peerId: string, name: string, team: TeamId, roomId: string): PlayerSnapshot | undefined {
    try {
      const raw = sessionStorage.getItem(PLAYER_STATE_STORAGE_KEY);
      if (!raw) return undefined;
      const stored = JSON.parse(raw) as { roomId: string; player: PlayerSnapshot };
      if (
        stored.roomId !== roomId ||
        stored.player.id !== peerId ||
        stored.player.team !== team ||
        typeof stored.player.weaponId !== "string"
      ) return undefined;
      return {
        ...stored.player,
        name,
        wallAttached: Boolean(stored.player.wallAttached),
        wallSurfaceId: stored.player.wallSurfaceId || ""
      };
    } catch {
      return undefined;
    }
  }
}
