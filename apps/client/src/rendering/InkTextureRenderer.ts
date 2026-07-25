import type { ICanvasRenderingContext } from "@babylonjs/core/Engines/ICanvas";
import type { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import type { PaintStamp } from "@tofu/protocol";
import { groundPointToCanvasUv, wallPointToCanvasUv } from "@tofu/simulation";
import type { InkTileSnapshot } from "@tofu/simulation/ink";
import type { WallSurface } from "@tofu/simulation/level";

export class InkTextureRenderer {
  constructor(
    private readonly ground: DynamicTexture,
    private readonly walls: ReadonlyMap<string, DynamicTexture>,
    private readonly textureSize: number,
    private readonly teamColors: readonly [string, string],
    private readonly groundHalfSize: number,
    private readonly wallSurfaces: readonly WallSurface[],
    private readonly neutralColors: {
      ground: string;
      obstacle: string;
      arenaWall: string;
    }
  ) {}

  applyStamp(stamp: PaintStamp) {
    const texture = stamp.surfaceId === "ground" ? this.ground : this.walls.get(stamp.surfaceId);
    if (!texture) return;
    const context = texture.getContext();
    const surface = stamp.surfaceId === "ground"
      ? undefined
      : this.wallSurfaces.find((candidate) => candidate.id === stamp.surfaceId);
    const uv = stamp.surfaceId === "ground"
      ? groundPointToCanvasUv({ x: stamp.x, z: stamp.z }, this.groundHalfSize)
      : surface ? wallPointToCanvasUv(surface, stamp) : undefined;
    if (!uv) return;
    const scaleU = stamp.surfaceId === "ground"
      ? this.textureSize / (this.groundHalfSize * 2)
      : this.textureSize / (surface!.maxAlong - surface!.minAlong);
    const scaleV = stamp.surfaceId === "ground"
      ? this.textureSize / 24
      : this.textureSize / surface!.height;
    drawEllipse(
      context,
      uv.u * this.textureSize,
      uv.v * this.textureSize,
      stamp.radiusU * scaleU,
      stamp.radiusV * scaleV,
      canvasRotation(stamp, surface),
      this.teamColors[stamp.team]
    );
    texture.update(true);
  }

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

function canvasRotation(stamp: PaintStamp, surface: WallSurface | undefined) {
  if (!surface) return -stamp.rotation;
  const invertAlong = surface.axis === "x" ? surface.normalX < 0 : surface.normalZ > 0;
  const directionU = Math.cos(stamp.rotation) * (invertAlong ? -1 : 1);
  const directionV = -Math.sin(stamp.rotation);
  return Math.atan2(directionV, directionU);
}

function drawEllipse(
  context: ICanvasRenderingContext,
  x: number,
  y: number,
  radiusX: number,
  radiusY: number,
  rotation: number,
  color: string
) {
  context.save();
  context.translate(x, y);
  context.rotate(rotation);
  context.scale(radiusX, radiusY);
  context.beginPath();
  context.arc(0, 0, 1, 0, Math.PI * 2);
  context.restore();
  context.fillStyle = color;
  context.fill();
}
