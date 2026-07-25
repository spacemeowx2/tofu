import type { TeamId, WallSurfaceId } from "@tofu/protocol";

export type LevelBox = {
  id: string;
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
};

export type LevelSpawn = { x: number; z: number };

export type LevelDefinition = {
  id: string;
  displayName: string;
  halfSize: number;
  arenaWallHeight: number;
  obstacles: readonly LevelBox[];
  spawns: Readonly<Record<TeamId, readonly LevelSpawn[]>>;
};

export type WallSurface = {
  id: WallSurfaceId;
  boxId: string;
  axis: "x" | "z";
  coordinate: number;
  minAlong: number;
  maxAlong: number;
  height: number;
  normalX: number;
  normalZ: number;
};

export const TOFU_TEST_LEVEL: LevelDefinition = {
  id: "tofu-test",
  displayName: "豆腐训练场",
  halfSize: 12,
  arenaWallHeight: 0.45,
  obstacles: [
    { id: "cover-west", x: -4.5, z: 0, width: 2.2, depth: 5.2, height: 2.2 },
    { id: "cover-east", x: 4.5, z: 0, width: 2.2, depth: 5.2, height: 2.2 },
    { id: "cover-south", x: 0, z: -5.5, width: 4.2, depth: 1.8, height: 1.4 },
    { id: "cover-north", x: 0, z: 5.5, width: 4.2, depth: 1.8, height: 1.4 }
  ],
  spawns: {
    0: [{ x: -7.5, z: -6.5 }, { x: -7.5, z: 6.5 }, { x: -4.5, z: 0 }],
    1: [{ x: 7.5, z: 6.5 }, { x: 7.5, z: -6.5 }, { x: 4.5, z: 0 }]
  }
};

export function createLevelWallSurfaces(level: LevelDefinition): readonly WallSurface[] {
  const obstacleSurfaces = level.obstacles.flatMap((box, index): WallSurface[] => [
    {
      id: `obstacle-${index}-px`,
      boxId: box.id,
      axis: "x",
      coordinate: box.x + box.width / 2,
      minAlong: box.z - box.depth / 2,
      maxAlong: box.z + box.depth / 2,
      height: box.height,
      normalX: 1,
      normalZ: 0
    },
    {
      id: `obstacle-${index}-nx`,
      boxId: box.id,
      axis: "x",
      coordinate: box.x - box.width / 2,
      minAlong: box.z - box.depth / 2,
      maxAlong: box.z + box.depth / 2,
      height: box.height,
      normalX: -1,
      normalZ: 0
    },
    {
      id: `obstacle-${index}-pz`,
      boxId: box.id,
      axis: "z",
      coordinate: box.z + box.depth / 2,
      minAlong: box.x - box.width / 2,
      maxAlong: box.x + box.width / 2,
      height: box.height,
      normalX: 0,
      normalZ: 1
    },
    {
      id: `obstacle-${index}-nz`,
      boxId: box.id,
      axis: "z",
      coordinate: box.z - box.depth / 2,
      minAlong: box.x - box.width / 2,
      maxAlong: box.x + box.width / 2,
      height: box.height,
      normalX: 0,
      normalZ: -1
    }
  ]);
  const half = level.halfSize;
  const height = level.arenaWallHeight;
  return [
    ...obstacleSurfaces,
    { id: "arena-east", boxId: "arena-east", axis: "x", coordinate: half, minAlong: -half, maxAlong: half, height, normalX: -1, normalZ: 0 },
    { id: "arena-west", boxId: "arena-west", axis: "x", coordinate: -half, minAlong: -half, maxAlong: half, height, normalX: 1, normalZ: 0 },
    { id: "arena-north", boxId: "arena-north", axis: "z", coordinate: half, minAlong: -half, maxAlong: half, height, normalX: 0, normalZ: -1 },
    { id: "arena-south", boxId: "arena-south", axis: "z", coordinate: -half, minAlong: -half, maxAlong: half, height, normalX: 0, normalZ: 1 }
  ];
}

export function getTeamSpawn(level: LevelDefinition, team: TeamId, slot: number): LevelSpawn {
  const candidates = level.spawns[team];
  return candidates[slot % candidates.length];
}
