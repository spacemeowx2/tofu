import { Effect } from "@babylonjs/core/Materials/effect";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { PaintSurfaceId } from "@tofu/protocol";
import {
  DEFAULT_INK_RESOLUTION,
  wallInkGridSize,
  type InkTileSnapshot
} from "@tofu/simulation/ink";
import type { WallSurface } from "@tofu/simulation/level";

const MASK_NEUTRAL = "rgb(0 0 0)";
const MASK_TEAMS = ["rgb(255 0 0)", "rgb(0 255 0)"] as const;

type InkSurface = {
  texture: DynamicTexture;
  material: ShaderMaterial;
  width: number;
  height: number;
  invertAlong: boolean;
};

type PendingTile = {
  snapshot: InkTileSnapshot;
  revealAt: number;
};

Effect.ShadersStore.inkSurfaceVertexShader = `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
uniform mat4 world;
uniform mat4 worldViewProjection;
varying vec3 vPositionW;
varying vec3 vNormalW;
varying vec2 vUV;
void main(void) {
  vec4 positionW = world * vec4(position, 1.0);
  vPositionW = positionW.xyz;
  vNormalW = normalize(mat3(world) * normal);
  vUV = uv;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}`;

Effect.ShadersStore.inkSurfaceFragmentShader = `
precision highp float;
uniform sampler2D inkMask;
uniform vec2 texelSize;
uniform vec3 neutralColor;
uniform vec3 team0Color;
uniform vec3 team1Color;
uniform vec3 lightDirection;
uniform vec3 cameraPosition;
uniform vec3 surfaceU;
uniform vec3 surfaceV;
varying vec3 vPositionW;
varying vec3 vNormalW;
varying vec2 vUV;

float inkHeight(vec2 uv) {
  vec2 mask = texture2D(inkMask, uv).rg;
  return smoothstep(0.08, 0.62, min(1.0, mask.r + mask.g));
}

void main(void) {
  vec2 mask = texture2D(inkMask, vUV).rg;
  float coverage = smoothstep(0.08, 0.62, min(1.0, mask.r + mask.g));
  float allegiance = smoothstep(-0.04, 0.04, mask.r - mask.g);
  vec3 inkColor = mix(team1Color, team0Color, allegiance);

  float left = inkHeight(vUV - vec2(texelSize.x, 0.0));
  float right = inkHeight(vUV + vec2(texelSize.x, 0.0));
  float down = inkHeight(vUV - vec2(0.0, texelSize.y));
  float up = inkHeight(vUV + vec2(0.0, texelSize.y));
  vec3 wetNormal = normalize(vNormalW - surfaceU * (right - left) * 0.8 - surfaceV * (up - down) * 0.8);
  vec3 shadedNormal = normalize(mix(vNormalW, wetNormal, coverage));
  vec3 light = normalize(-lightDirection);
  vec3 view = normalize(cameraPosition - vPositionW);
  float diffuse = 0.68 + 0.32 * max(dot(shadedNormal, light), 0.0);
  float wetSpecular = pow(max(dot(reflect(-light, shadedNormal), view), 0.0), 72.0) * coverage * 0.9;
  float rim = pow(1.0 - max(dot(shadedNormal, view), 0.0), 3.0) * coverage * 0.12;
  vec3 base = mix(neutralColor, inkColor, coverage);
  gl_FragColor = vec4(base * diffuse + vec3(wetSpecular + rim), 1.0);
}`;

export class InkTextureRenderer {
  private readonly surfaces = new Map<PaintSurfaceId, InkSurface>();
  private readonly pendingTiles = new Map<string, PendingTile>();
  private time = 0;

  constructor(
    private readonly scene: Scene,
    wallSurfaces: readonly WallSurface[],
    teamColors: readonly [string, string],
    neutralColors: {
      ground: string;
      obstacle: string;
      arenaWall: string;
    }
  ) {
    this.surfaces.set("ground", this.createSurface(
      "ground",
      DEFAULT_INK_RESOLUTION,
      DEFAULT_INK_RESOLUTION,
      false,
      neutralColors.ground,
      teamColors,
      new Vector3(1, 0, 0),
      new Vector3(0, 0, -1)
    ));
    wallSurfaces.forEach((surface) => {
      const { width, height } = wallInkGridSize(surface);
      const invertAlong = surface.axis === "x" ? surface.normalX < 0 : surface.normalZ > 0;
      const along = surface.axis === "x"
        ? new Vector3(0, 0, invertAlong ? -1 : 1)
        : new Vector3(invertAlong ? -1 : 1, 0, 0);
      this.surfaces.set(surface.id, this.createSurface(
        surface.id,
        width,
        height,
        invertAlong,
        surface.id.startsWith("obstacle-") ? neutralColors.obstacle : neutralColors.arenaWall,
        teamColors,
        along,
        new Vector3(0, -1, 0)
      ));
    });
  }

  groundMaterial() {
    return this.surfaces.get("ground")!.material;
  }

  wallMaterial(surfaceId: PaintSurfaceId) {
    return this.surfaces.get(surfaceId)?.material;
  }

  applyTile(snapshot: InkTileSnapshot) {
    const pending = this.pendingTiles.get(tileKey(snapshot));
    if (pending) {
      pending.snapshot = snapshot;
      return;
    }
    const surface = this.writeTile(snapshot);
    surface?.texture.update(true);
  }

  applyTiles(snapshots: readonly InkTileSnapshot[]) {
    const dirty = new Set<InkSurface>();
    snapshots.forEach((snapshot) => {
      const pending = this.pendingTiles.get(tileKey(snapshot));
      if (pending) {
        pending.snapshot = snapshot;
        return;
      }
      const surface = this.writeTile(snapshot);
      if (surface) dirty.add(surface);
    });
    dirty.forEach((surface) => surface.texture.update(true));
  }

  settleTiles(snapshots: readonly InkTileSnapshot[], delaySeconds: number) {
    snapshots.forEach((snapshot) => {
      const key = tileKey(snapshot);
      const existing = this.pendingTiles.get(key);
      this.pendingTiles.set(key, {
        snapshot,
        revealAt: Math.max(existing?.revealAt ?? 0, this.time + delaySeconds)
      });
    });
  }

  update(dt: number) {
    this.time += dt;
    const dirty = new Set<InkSurface>();
    this.pendingTiles.forEach((pending, key) => {
      if (pending.revealAt > this.time) return;
      this.pendingTiles.delete(key);
      const surface = this.writeTile(pending.snapshot);
      if (surface) dirty.add(surface);
    });
    dirty.forEach((surface) => surface.texture.update(true));
    const camera = this.scene.activeCamera;
    if (!camera) return;
    this.surfaces.forEach((surface) => surface.material.setVector3("cameraPosition", camera.position));
  }

  private writeTile(snapshot: InkTileSnapshot) {
    const surface = this.surfaces.get(snapshot.surfaceId);
    if (!surface || surface.width !== snapshot.gridWidth || surface.height !== snapshot.gridHeight) return undefined;
    const context = surface.texture.getContext();
    const startX = snapshot.tileX * snapshot.tileSize;
    const startY = snapshot.tileY * snapshot.tileSize;
    for (let y = 0; y < snapshot.height; y += 1) {
      for (let x = 0; x < snapshot.width; x += 1) {
        const logicalX = startX + x;
        const canvasX = surface.invertAlong ? surface.width - logicalX - 1 : logicalX;
        const canvasY = surface.height - startY - y - 1;
        const owner = snapshot.owners[y * snapshot.width + x];
        context.fillStyle = owner === 0 || owner === 1 ? MASK_TEAMS[owner] : MASK_NEUTRAL;
        context.fillRect(canvasX, canvasY, 1, 1);
      }
    }
    return surface;
  }

  private createSurface(
    id: PaintSurfaceId,
    width: number,
    height: number,
    invertAlong: boolean,
    neutralColor: string,
    teamColors: readonly [string, string],
    surfaceU: Vector3,
    surfaceV: Vector3
  ): InkSurface {
    const texture = new DynamicTexture(
      `ink-mask-${id}`,
      { width, height },
      this.scene,
      false,
      Texture.BILINEAR_SAMPLINGMODE
    );
    texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    const context = texture.getContext();
    context.fillStyle = MASK_NEUTRAL;
    context.fillRect(0, 0, width, height);
    texture.update(true);

    const material = new ShaderMaterial(
      `ink-surface-material-${id}`,
      this.scene,
      { vertex: "inkSurface", fragment: "inkSurface" },
      {
        attributes: ["position", "normal", "uv"],
        uniforms: [
          "world",
          "worldViewProjection",
          "texelSize",
          "neutralColor",
          "team0Color",
          "team1Color",
          "lightDirection",
          "cameraPosition",
          "surfaceU",
          "surfaceV"
        ],
        samplers: ["inkMask"]
      }
    );
    material.backFaceCulling = true;
    material.setTexture("inkMask", texture);
    material.setVector2("texelSize", new Vector2(1 / width, 1 / height));
    material.setColor3("neutralColor", Color3.FromHexString(neutralColor));
    material.setColor3("team0Color", Color3.FromHexString(teamColors[0]));
    material.setColor3("team1Color", Color3.FromHexString(teamColors[1]));
    material.setVector3("lightDirection", new Vector3(-0.45, -1, 0.3).normalize());
    material.setVector3("cameraPosition", Vector3.Zero());
    material.setVector3("surfaceU", surfaceU);
    material.setVector3("surfaceV", surfaceV);
    return { texture, material, width, height, invertAlong };
  }
}

function tileKey(snapshot: Pick<InkTileSnapshot, "surfaceId" | "tileX" | "tileY">) {
  return `${snapshot.surfaceId}:${snapshot.tileX}:${snapshot.tileY}`;
}
