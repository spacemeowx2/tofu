export const ROOM_NAME = "tofu_arena";
export const PROTOCOL_VERSION = 3;
export const PLAYER_MAX_HP = 100;
export const BULLET_DAMAGE = 36;
export const BULLET_SPEED = 15.5;
export const BULLET_RADIUS = 0.2;
export const BULLET_GRAVITY = 7.5;
export const SHOT_COOLDOWN_MS = 100;
export const ARENA_HALF_SIZE = 12;
export const PLAYER_RADIUS = 0.45;
export const PLAYER_COLLIDER_HEIGHT = 1.3;
export const PLAYER_DIVE_RADIUS = 0.32;
export const PLAYER_DIVE_COLLIDER_HEIGHT = 0.5;

export const ARENA_OBSTACLES = [
  { x: -4.5, z: 0, width: 2.2, depth: 5.2, height: 2.2 },
  { x: 4.5, z: 0, width: 2.2, depth: 5.2, height: 2.2 },
  { x: 0, z: -5.5, width: 4.2, depth: 1.8, height: 1.4 },
  { x: 0, z: 5.5, width: 4.2, depth: 1.8, height: 1.4 }
] as const;

export type TeamId = 0 | 1;
export type WeaponId = string;
export type ObstacleWallSurfaceId = `obstacle-${number}-${"px" | "nx" | "pz" | "nz"}`;
export type ArenaWallSurfaceId = `arena-${"east" | "west" | "north" | "south"}`;
export type WallSurfaceId = ObstacleWallSurfaceId | ArenaWallSurfaceId;
export type PaintSurfaceId = "ground" | WallSurfaceId;

export type PlayerSnapshot = {
  id: string;
  name: string;
  team: TeamId;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  facingX: number;
  facingZ: number;
  hp: number;
  alive: boolean;
  diving: boolean;
  wallAttached: boolean;
  wallSurfaceId: WallSurfaceId | "";
};

export type BulletSnapshot = {
  id: string;
  ownerId: string;
  team: TeamId;
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
  age: number;
  distanceTraveled: number;
  paintTrailIndex: number;
  seed: number;
  weaponId: WeaponId;
};

type PacketHeader = {
  protocolVersion: typeof PROTOCOL_VERSION;
  peerId: string;
  sequence: number;
  simulationTick: number;
};

export type PlayerStatePacket = PacketHeader & {
  kind: "player_state";
  player: PlayerSnapshot;
};

export type ShotPacket = PacketHeader & {
  kind: "shot";
  bullet: BulletSnapshot;
};

export type HitPacket = PacketHeader & {
  kind: "hit";
  bulletId: string;
  weaponId: WeaponId;
  targetId: string;
  damage: number;
};

export type BulletRemovedPacket = PacketHeader & {
  kind: "bullet_removed";
  bulletId: string;
};

type PaintStampBase = {
  id: string;
  team: TeamId;
  x: number;
  y: number;
  z: number;
  radiusU: number;
  radiusV: number;
  rotation: number;
};

export type GroundPaintStamp = PaintStampBase & { surfaceId: "ground" };
export type WallPaintStamp = PaintStampBase & { surfaceId: WallSurfaceId };
export type PaintStamp = GroundPaintStamp | WallPaintStamp;

export type PaintPacket = PacketHeader & {
  kind: "paint";
  stamps: PaintStamp[];
};

export type InkTileSnapshotDto = {
  surfaceId: PaintSurfaceId;
  tileX: number;
  tileY: number;
  tileSize: number;
  gridWidth: number;
  gridHeight: number;
  width: number;
  height: number;
  owners: number[];
  ticks: number[];
  hash: number;
};

export type InkTilePacket = PacketHeader & {
  kind: "ink_tile";
  tile: InkTileSnapshotDto;
};

export type PeerPacket =
  | PlayerStatePacket
  | ShotPacket
  | HitPacket
  | BulletRemovedPacket
  | PaintPacket
  | InkTilePacket;

export type RelayedPeerPacket = {
  from: string;
  packet: PeerPacket;
};
