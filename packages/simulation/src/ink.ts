import type { PaintStamp, PaintSurfaceId, TeamId, WallSurfaceId } from "@tofu/protocol";
import { createLevelWallSurfaces, type LevelDefinition, type WallSurface } from "./level.js";

const NEUTRAL = 255;

type SurfaceGrid = {
  surfaceId: PaintSurfaceId;
  width: number;
  height: number;
  owners: Uint8Array;
  ticks: Uint32Array;
  writers: Uint32Array;
  dirtyTiles: Set<string>;
};

export type InkTileSnapshot = {
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

export type InkFieldSnapshot = {
  version: 2;
  resolution: number;
  tileSize: number;
  tiles: InkTileSnapshot[];
};

export type InkTileHash = {
  surfaceId: PaintSurfaceId;
  tileX: number;
  tileY: number;
  hash: number;
};

export class TiledInkField {
  private readonly ground: SurfaceGrid;
  private readonly walls = new Map<WallSurfaceId, { surface: WallSurface; grid: SurfaceGrid }>();

  constructor(
    private readonly level: LevelDefinition,
    readonly resolution = 128,
    readonly tileSize = 16,
    wallCellsPerUnit = 12
  ) {
    this.ground = createGrid("ground", resolution, resolution);
    for (const surface of createLevelWallSurfaces(level)) {
      const width = Math.max(1, Math.ceil((surface.maxAlong - surface.minAlong) * wallCellsPerUnit));
      const height = Math.max(1, Math.ceil(surface.height * wallCellsPerUnit));
      this.walls.set(surface.id, { surface, grid: createGrid(surface.id, width, height) });
    }
  }

  teamAt(x: number, z: number): TeamId | null {
    const cell = this.groundCell(x, z);
    if (!cell) return null;
    return ownerToTeam(this.ground.owners[cell.y * this.ground.width + cell.x]);
  }

  teamAtWall(surfaceId: WallSurfaceId, x: number, y: number, z: number): TeamId | null {
    const entry = this.walls.get(surfaceId);
    if (!entry) return null;
    const cell = this.wallCell(entry.surface, entry.grid, x, y, z);
    if (!cell) return null;
    return ownerToTeam(entry.grid.owners[cell.y * entry.grid.width + cell.x]);
  }

  paint(stamp: PaintStamp, tick = 0) {
    const writer = hashWriter(stamp.id);
    if (stamp.surfaceId === "ground") {
      return this.snapshotsForKeys(
        this.ground,
        this.paintGround(stamp, tick, writer)
      );
    }
    const entry = this.walls.get(stamp.surfaceId);
    if (!entry) return [];
    return this.snapshotsForKeys(
      entry.grid,
      this.paintWall(entry.surface, entry.grid, stamp, tick, writer)
    );
  }

  tileHashes(dirtyOnly = false): InkTileHash[] {
    const hashes: InkTileHash[] = [];
    for (const grid of this.grids()) {
      for (const { tileX, tileY } of tileCoordinates(grid, this.tileSize, dirtyOnly)) {
        hashes.push({
          surfaceId: grid.surfaceId,
          tileX,
          tileY,
          hash: hashTile(grid, tileX, tileY, this.tileSize)
        });
      }
    }
    return hashes;
  }

  snapshotTile(surfaceId: PaintSurfaceId, tileX: number, tileY: number): InkTileSnapshot | undefined {
    const grid = this.grid(surfaceId);
    if (!grid) return undefined;
    const startX = tileX * this.tileSize;
    const startY = tileY * this.tileSize;
    if (startX >= grid.width || startY >= grid.height) return undefined;
    const width = Math.min(this.tileSize, grid.width - startX);
    const height = Math.min(this.tileSize, grid.height - startY);
    const owners: number[] = [];
    const ticks: number[] = [];
    const writers: number[] = [];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (startY + y) * grid.width + startX + x;
        owners.push(grid.owners[index]);
        ticks.push(grid.ticks[index]);
        writers.push(grid.writers[index]);
      }
    }
    return {
      surfaceId,
      tileX,
      tileY,
      tileSize: this.tileSize,
      gridWidth: grid.width,
      gridHeight: grid.height,
      width,
      height,
      owners,
      ticks,
      writers,
      hash: hashArrays(owners, ticks, writers)
    };
  }

  applyTileSnapshot(snapshot: InkTileSnapshot) {
    const grid = this.grid(snapshot.surfaceId);
    if (
      !grid ||
      snapshot.tileSize !== this.tileSize ||
      snapshot.gridWidth !== grid.width ||
      snapshot.gridHeight !== grid.height ||
      !Number.isInteger(snapshot.tileX) ||
      !Number.isInteger(snapshot.tileY) ||
      snapshot.tileX < 0 ||
      snapshot.tileY < 0 ||
      !Number.isInteger(snapshot.width) ||
      !Number.isInteger(snapshot.height) ||
      snapshot.width <= 0 ||
      snapshot.height <= 0 ||
      snapshot.width > this.tileSize ||
      snapshot.height > this.tileSize ||
      !Array.isArray(snapshot.owners) ||
      !Array.isArray(snapshot.ticks) ||
      !Array.isArray(snapshot.writers)
    ) return false;
    const startX = snapshot.tileX * snapshot.tileSize;
    const startY = snapshot.tileY * snapshot.tileSize;
    if (
      startX + snapshot.width > grid.width ||
      startY + snapshot.height > grid.height ||
      snapshot.owners.length !== snapshot.width * snapshot.height ||
      snapshot.ticks.length !== snapshot.owners.length ||
      snapshot.writers.length !== snapshot.owners.length ||
      snapshot.owners.some((owner) => owner !== 0 && owner !== 1 && owner !== NEUTRAL) ||
      snapshot.ticks.some((tick) => !Number.isSafeInteger(tick) || tick < 0) ||
      snapshot.writers.some((writer) => !Number.isSafeInteger(writer) || writer < 0 || writer > 0xffff_ffff) ||
      snapshot.hash !== hashArrays(snapshot.owners, snapshot.ticks, snapshot.writers)
    ) return false;
    let changed = false;
    for (let y = 0; y < snapshot.height; y += 1) {
      for (let x = 0; x < snapshot.width; x += 1) {
        const sourceIndex = y * snapshot.width + x;
        const targetIndex = (startY + y) * grid.width + startX + x;
        if (
          snapshot.ticks[sourceIndex] < grid.ticks[targetIndex] ||
          (
            snapshot.ticks[sourceIndex] === grid.ticks[targetIndex] &&
            snapshot.writers[sourceIndex] <= grid.writers[targetIndex]
          )
        ) continue;
        grid.owners[targetIndex] = snapshot.owners[sourceIndex];
        grid.ticks[targetIndex] = snapshot.ticks[sourceIndex];
        grid.writers[targetIndex] = snapshot.writers[sourceIndex];
        changed = true;
      }
    }
    if (changed) grid.dirtyTiles.add(tileKey(snapshot.tileX, snapshot.tileY));
    return true;
  }

  snapshot(): InkFieldSnapshot {
    const tiles: InkTileSnapshot[] = [];
    for (const grid of this.grids()) {
      for (const { tileX, tileY } of tileCoordinates(grid, this.tileSize, false)) {
        const tile = this.snapshotTile(grid.surfaceId, tileX, tileY);
        if (tile) tiles.push(tile);
      }
    }
    return { version: 2, resolution: this.resolution, tileSize: this.tileSize, tiles };
  }

  restore(snapshot: InkFieldSnapshot) {
    if (snapshot.version !== 2 || snapshot.resolution !== this.resolution || snapshot.tileSize !== this.tileSize) {
      throw new Error("Incompatible ink snapshot");
    }
    for (const grid of this.grids()) {
      grid.owners.fill(NEUTRAL);
      grid.ticks.fill(0);
      grid.writers.fill(0);
      grid.dirtyTiles.clear();
    }
    snapshot.tiles.forEach((tile) => this.applyTileSnapshot(tile));
  }

  takeDirtyTileSnapshots(): InkTileSnapshot[] {
    const snapshots: InkTileSnapshot[] = [];
    for (const grid of this.grids()) {
      for (const key of grid.dirtyTiles) {
        const [tileX, tileY] = key.split(":").map(Number);
        const snapshot = this.snapshotTile(grid.surfaceId, tileX, tileY);
        if (snapshot) snapshots.push(snapshot);
      }
      grid.dirtyTiles.clear();
    }
    return snapshots;
  }

  private paintGround(stamp: PaintStamp & { surfaceId: "ground" }, tick: number, writer: number) {
    const changedTiles = new Set<string>();
    const maxRadius = Math.max(stamp.radiusU, stamp.radiusV);
    const min = this.groundCell(stamp.x - maxRadius, stamp.z - maxRadius, true)!;
    const max = this.groundCell(stamp.x + maxRadius, stamp.z + maxRadius, true)!;
    for (let y = min.y; y <= max.y; y += 1) {
      for (let x = min.x; x <= max.x; x += 1) {
        const worldX = (x + 0.5) / this.ground.width * this.level.halfSize * 2 - this.level.halfSize;
        const worldZ = (y + 0.5) / this.ground.height * this.level.halfSize * 2 - this.level.halfSize;
        if (!ellipseContains(worldX - stamp.x, worldZ - stamp.z, stamp.radiusU, stamp.radiusV, stamp.rotation)) continue;
        if (setCell(this.ground, x, y, stamp.team, tick, writer, this.tileSize)) {
          changedTiles.add(tileKey(Math.floor(x / this.tileSize), Math.floor(y / this.tileSize)));
        }
      }
    }
    return changedTiles;
  }

  private paintWall(surface: WallSurface, grid: SurfaceGrid, stamp: PaintStamp, tick: number, writer: number) {
    const changedTiles = new Set<string>();
    const stampU = surface.axis === "x" ? stamp.z : stamp.x;
    const maxRadius = Math.max(stamp.radiusU, stamp.radiusV);
    const minU = Math.max(0, Math.floor((stampU - maxRadius - surface.minAlong) / (surface.maxAlong - surface.minAlong) * grid.width));
    const maxU = Math.min(grid.width - 1, Math.floor((stampU + maxRadius - surface.minAlong) / (surface.maxAlong - surface.minAlong) * grid.width));
    const minV = Math.max(0, Math.floor((stamp.y - maxRadius) / surface.height * grid.height));
    const maxV = Math.min(grid.height - 1, Math.floor((stamp.y + maxRadius) / surface.height * grid.height));
    for (let y = minV; y <= maxV; y += 1) {
      for (let x = minU; x <= maxU; x += 1) {
        const worldU = surface.minAlong + (x + 0.5) / grid.width * (surface.maxAlong - surface.minAlong);
        const worldV = (y + 0.5) / grid.height * surface.height;
        if (!ellipseContains(worldU - stampU, worldV - stamp.y, stamp.radiusU, stamp.radiusV, stamp.rotation)) continue;
        if (setCell(grid, x, y, stamp.team, tick, writer, this.tileSize)) {
          changedTiles.add(tileKey(Math.floor(x / this.tileSize), Math.floor(y / this.tileSize)));
        }
      }
    }
    return changedTiles;
  }

  private groundCell(x: number, z: number, clamp = false) {
    const cellX = Math.floor((x + this.level.halfSize) / (this.level.halfSize * 2) * this.ground.width);
    const cellY = Math.floor((z + this.level.halfSize) / (this.level.halfSize * 2) * this.ground.height);
    if (!clamp && (cellX < 0 || cellX >= this.ground.width || cellY < 0 || cellY >= this.ground.height)) return undefined;
    return {
      x: Math.max(0, Math.min(this.ground.width - 1, cellX)),
      y: Math.max(0, Math.min(this.ground.height - 1, cellY))
    };
  }

  private wallCell(surface: WallSurface, grid: SurfaceGrid, x: number, y: number, z: number) {
    const along = surface.axis === "x" ? z : x;
    if (along < surface.minAlong || along > surface.maxAlong || y < 0 || y > surface.height) return undefined;
    return {
      x: Math.min(grid.width - 1, Math.floor((along - surface.minAlong) / (surface.maxAlong - surface.minAlong) * grid.width)),
      y: Math.min(grid.height - 1, Math.floor(y / surface.height * grid.height))
    };
  }

  private grid(surfaceId: PaintSurfaceId) {
    return surfaceId === "ground" ? this.ground : this.walls.get(surfaceId)?.grid;
  }

  private *grids(): Generator<SurfaceGrid> {
    yield this.ground;
    for (const { grid } of this.walls.values()) yield grid;
  }

  private snapshotsForKeys(grid: SurfaceGrid, keys: ReadonlySet<string>) {
    const snapshots: InkTileSnapshot[] = [];
    for (const key of keys) {
      const [tileX, tileY] = key.split(":").map(Number);
      const snapshot = this.snapshotTile(grid.surfaceId, tileX, tileY);
      if (snapshot) snapshots.push(snapshot);
    }
    return snapshots;
  }
}

function createGrid(surfaceId: PaintSurfaceId, width: number, height: number): SurfaceGrid {
  const owners = new Uint8Array(width * height);
  owners.fill(NEUTRAL);
  return {
    surfaceId,
    width,
    height,
    owners,
    ticks: new Uint32Array(width * height),
    writers: new Uint32Array(width * height),
    dirtyTiles: new Set()
  };
}

function setCell(
  grid: SurfaceGrid,
  x: number,
  y: number,
  team: TeamId,
  tick: number,
  writer: number,
  tileSize: number
) {
  const index = y * grid.width + x;
  if (tick < grid.ticks[index] || (tick === grid.ticks[index] && writer <= grid.writers[index])) return false;
  grid.owners[index] = team;
  grid.ticks[index] = tick;
  grid.writers[index] = writer;
  grid.dirtyTiles.add(tileKey(Math.floor(x / tileSize), Math.floor(y / tileSize)));
  return true;
}

function* tileCoordinates(grid: SurfaceGrid, tileSize: number, dirtyOnly: boolean) {
  if (dirtyOnly) {
    for (const key of grid.dirtyTiles) {
      const [tileX, tileY] = key.split(":").map(Number);
      yield { tileX, tileY };
    }
    return;
  }
  for (let tileY = 0; tileY < Math.ceil(grid.height / tileSize); tileY += 1) {
    for (let tileX = 0; tileX < Math.ceil(grid.width / tileSize); tileX += 1) yield { tileX, tileY };
  }
}

function hashTile(grid: SurfaceGrid, tileX: number, tileY: number, tileSize: number) {
  const startX = tileX * tileSize;
  const startY = tileY * tileSize;
  const width = Math.min(tileSize, grid.width - startX);
  const height = Math.min(tileSize, grid.height - startY);
  const owners: number[] = [];
  const ticks: number[] = [];
  const writers: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (startY + y) * grid.width + startX + x;
      owners.push(grid.owners[index]);
      ticks.push(grid.ticks[index]);
      writers.push(grid.writers[index]);
    }
  }
  return hashArrays(owners, ticks, writers);
}

function ownerToTeam(owner: number): TeamId | null {
  return owner === 0 || owner === 1 ? owner : null;
}

function tileKey(tileX: number, tileY: number) {
  return `${tileX}:${tileY}`;
}

function hashArrays(owners: readonly number[], ticks: readonly number[], writers: readonly number[]) {
  let hash = 2166136261;
  for (let index = 0; index < owners.length; index += 1) {
    hash ^= owners[index];
    hash = Math.imul(hash, 16777619);
    hash ^= ticks[index];
    hash = Math.imul(hash, 16777619);
    hash ^= writers[index];
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hashWriter(id: string) {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0 || 1;
}

function ellipseContains(deltaU: number, deltaV: number, radiusU: number, radiusV: number, rotation: number) {
  if (radiusU <= 0 || radiusV <= 0) return false;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const localU = deltaU * cos + deltaV * sin;
  const localV = -deltaU * sin + deltaV * cos;
  return (localU / radiusU) ** 2 + (localV / radiusV) ** 2 <= 1;
}
