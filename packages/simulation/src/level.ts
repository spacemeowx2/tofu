import type { HorizontalSurfaceId, TeamId, WallSurfaceId } from "@tofu/protocol";

export type LevelBox = {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
};

export type LevelSpawn = { readonly x: number; readonly z: number };

export type LevelDefinition = {
  readonly id: string;
  readonly displayName: string;
  readonly halfSize: number;
  readonly arenaWallHeight: number;
  readonly obstacles: readonly LevelBox[];
  readonly spawns: Readonly<Record<TeamId, readonly LevelSpawn[]>>;
  readonly targets?: readonly { id: string; x: number; z: number; y: number }[];
};

export type FloorSurface = {
  id: HorizontalSurfaceId;
  x: number;
  z: number;
  width: number;
  depth: number;
  y: number;
};

export function createLevelFloorSurfaces(level: LevelDefinition): readonly FloorSurface[] {
  return [
    { id: "ground", x: 0, z: 0, width: level.halfSize * 2, depth: level.halfSize * 2, y: 0 },
    ...level.obstacles.map((box, index) => ({
      id: `top-${index}` as const, x: box.x, z: box.z,
      width: box.width, depth: box.depth, y: box.height
    }))
  ];
}

export const TOFU_ARENA_LEVEL: LevelDefinition = {
  id: "rooftop-yard",
  displayName: "屋顶试射场",
  halfSize: 14,
  arenaWallHeight: 1.1,
  obstacles: [
    { id: "center-west", x: -3.8, z: 0, width: 2.4, depth: 4.2, height: 2.4 },
    { id: "center-east", x: 3.8, z: 0, width: 2.4, depth: 4.2, height: 2.4 },
    { id: "south-platform", x: -5.4, z: -5.8, width: 4.2, depth: 3.2, height: 1.1 },
    { id: "north-platform", x: 5.4, z: 5.8, width: 4.2, depth: 3.2, height: 1.1 },
    { id: "south-step", x: -5.4, z: -8.1, width: 4.2, depth: 1.2, height: 0.5 },
    { id: "north-step", x: 5.4, z: 8.1, width: 4.2, depth: 1.2, height: 0.5 },
    { id: "east-cover", x: 8.6, z: -2.8, width: 1.4, depth: 4, height: 1.7 },
    { id: "west-cover", x: -8.6, z: 2.8, width: 1.4, depth: 4, height: 1.7 }
  ],
  spawns: {
    0: [{ x: 0, z: -8.5 }, { x: -2, z: -10 }, { x: 2, z: -10 }, { x: -7, z: -10 }],
    1: [{ x: 0, z: 8.5 }, { x: 2, z: 10 }, { x: -2, z: 10 }, { x: 7, z: 10 }]
  },
  targets: [
    { id: "target-near", x: 2.1, y: 0, z: -6 },
    { id: "target-mid", x: 0, y: 0, z: -2.6 },
    { id: "target-far", x: -2.1, y: 0, z: 3.2 },
    { id: "target-north", x: -2.1, y: 0, z: 6 }
  ]
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

export const COMPACT_TEST_LEVEL: LevelDefinition = {
  id: "compact-test",
  displayName: "紧凑测试场",
  halfSize: 8,
  arenaWallHeight: 1.2,
  obstacles: [
    { id: "center-cover", x: 0, z: 0, width: 2, depth: 2, height: 1.6 }
  ],
  spawns: {
    0: [{ x: -5, z: 0 }],
    1: [{ x: 5, z: 0 }]
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
