export const ROOM_NAME = "tofu_arena";
export const SERVER_TICK_RATE = 30;
export const PLAYER_MAX_HP = 100;
export const BULLET_DAMAGE = 25;
export const ARENA_HALF_SIZE = 12;
export const PLAYER_RADIUS = 0.65;

export const ARENA_OBSTACLES = [
  { x: -4.5, z: 0, width: 2.2, depth: 5.2, height: 2.2 },
  { x: 4.5, z: 0, width: 2.2, depth: 5.2, height: 2.2 },
  { x: 0, z: -5.5, width: 4.2, depth: 1.8, height: 1.4 },
  { x: 0, z: 5.5, width: 4.2, depth: 1.8, height: 1.4 }
] as const;

export type MoveInput = {
  x: number;
  z: number;
  sequence: number;
};

export type ShootInput = {
  dx: number;
  dy: number;
  dz: number;
  sequence: number;
};

export type GameEvent = {
  kind: "hit" | "knockout" | "respawn" | "joined" | "left";
  message: string;
};
