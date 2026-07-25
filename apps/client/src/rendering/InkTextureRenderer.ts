import type { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import type { InkTileSnapshot } from "@tofu/simulation/ink";
import type { WallSurface } from "@tofu/simulation/level";

export class InkTextureRenderer {
  constructor(
    private readonly ground: DynamicTexture,
    private readonly walls: ReadonlyMap<string, DynamicTexture>,
    private readonly textureSize: number,
    private readonly teamColors: readonly [string, string],
    private readonly wallSurfaces: readonly WallSurface[],
    private readonly neutralColors: {
      ground: string;
      obstacle: string;
      arenaWall: string;
    }
  ) {}

  applyTile(snapshot: InkTileSnapshot) {
    const texture = snapshot.surfaceId === "ground" ? this.ground : this.walls.get(snapshot.surfaceId);
    if (!texture) return;
    const context = texture.getContext();
    const cellWidth = this.textureSize / snapshot.gridWidth;
    const cellHeight = this.textureSize / snapshot.gridHeight;
    const startX = snapshot.tileX * snapshot.tileSize;
    const startY = snapshot.tileY * snapshot.tileSize;
    const surface = snapshot.surfaceId === "ground"
      ? undefined
      : this.wallSurfaces.find((candidate) => candidate.id === snapshot.surfaceId);
    const invertAlong = surface
      ? surface.axis === "x" ? surface.normalX < 0 : surface.normalZ > 0
      : false;
    for (let y = 0; y < snapshot.height; y += 1) {
      for (let x = 0; x < snapshot.width; x += 1) {
        const owner = snapshot.owners[y * snapshot.width + x];
        context.fillStyle = owner === 0 || owner === 1
          ? this.teamColors[owner]
          : snapshot.surfaceId === "ground"
            ? this.neutralColors.ground
            : snapshot.surfaceId.startsWith("obstacle-")
              ? this.neutralColors.obstacle
              : this.neutralColors.arenaWall;
        const gridX = startX + x;
        const canvasGridX = invertAlong ? snapshot.gridWidth - gridX - 1 : gridX;
        context.fillRect(
          canvasGridX * cellWidth,
          this.textureSize - (startY + y + 1) * cellHeight,
          Math.ceil(cellWidth),
          Math.ceil(cellHeight)
        );
      }
    }
    texture.update(true);
  }
}
