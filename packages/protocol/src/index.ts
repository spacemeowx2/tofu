export const ROOM_NAME = "tofu_arena";
export const PROTOCOL_VERSION = 4;
export const PLAYER_MAX_HP = 100;
export const PLAYER_RADIUS = 0.45;
export const PLAYER_COLLIDER_HEIGHT = 1.3;
export const PLAYER_DIVE_RADIUS = 0.32;
export const PLAYER_DIVE_COLLIDER_HEIGHT = 0.5;

export type TeamId = 0 | 1;
export type WeaponId = string;
export type PhysicsKind = "analytic" | "rapier";
export type ObstacleWallSurfaceId = `obstacle-${number}-${"px" | "nx" | "pz" | "nz"}`;
export type ArenaWallSurfaceId = `arena-${"east" | "west" | "north" | "south"}`;
export type WallSurfaceId = ObstacleWallSurfaceId | ArenaWallSurfaceId;
export type PaintSurfaceId = "ground" | WallSurfaceId;

export type PlayerSnapshot = {
  id: string;
  name: string;
  team: TeamId;
  weaponId: WeaponId;
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
  contentId: string;
  levelId: string;
  physicsKind: PhysicsKind;
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
  writers: number[];
  hash: number;
};

export type InkTilePacket = PacketHeader & {
  kind: "ink_tile";
  targetPeerId?: string;
  tile: InkTileSnapshotDto;
};

export type InkTileHashDto = {
  surfaceId: PaintSurfaceId;
  tileX: number;
  tileY: number;
  hash: number;
};

export type InkHashesPacket = PacketHeader & {
  kind: "ink_hashes";
  hashes: InkTileHashDto[];
};

export type InkTileRequestPacket = PacketHeader & {
  kind: "ink_tile_request";
  targetPeerId: string;
  tiles: Array<Pick<InkTileHashDto, "surfaceId" | "tileX" | "tileY">>;
};

export type PeerPacket =
  | PlayerStatePacket
  | ShotPacket
  | HitPacket
  | BulletRemovedPacket
  | PaintPacket
  | InkTilePacket
  | InkHashesPacket
  | InkTileRequestPacket;

export type RelayedPeerPacket = {
  from: string;
  packet: PeerPacket;
};
