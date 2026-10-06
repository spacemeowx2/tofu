import { Effect } from "@babylonjs/core/Materials/effect";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { PaintSurfaceId } from "@tofu/protocol";
import { DEFAULT_INK_RESOLUTION, floorInkGridSize, wallInkGridSize, type InkTileSnapshot } from "@tofu/simulation/ink";
import { createLevelFloorSurfaces, createLevelWallSurfaces, type LevelDefinition } from "@tofu/simulation/level";

type InkSurface = { texture: DynamicTexture; material: ShaderMaterial; width: number; height: number; invertAlong: boolean };

Effect.ShadersStore.inkSurfaceVertexShader = `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
uniform mat4 world;
uniform mat4 worldViewProjection;
uniform sampler2D inkMask;
varying vec3 vPositionW;
varying vec3 vNormalW;
varying vec2 vUV;
void main(void) {
  vec2 mask = texture2D(inkMask, uv).rg;
  float ink = smoothstep(0.25, 0.75, mask.r + mask.g);
  vec3 raised = position + normal * ink * 0.024;
  vPositionW = (world * vec4(raised, 1.0)).xyz;
  vNormalW = normalize(mat3(world) * normal);
  vUV = uv;
  gl_Position = worldViewProjection * vec4(raised, 1.0);
}`;

Effect.ShadersStore.inkSurfaceFragmentShader = `
precision highp float;
uniform sampler2D inkMask;
uniform vec2 texelSize;
uniform vec2 surfaceSize;
uniform vec3 neutralColor;
uniform vec3 team0Color;
uniform vec3 team1Color;
uniform vec3 cameraPosition;
uniform vec3 surfaceU;
uniform vec3 surfaceV;
varying vec3 vPositionW;
varying vec3 vNormalW;
varying vec2 vUV;

vec2 inkAt(vec2 uv) {
  vec2 t = texelSize * 0.65;
  return texture2D(inkMask, uv).rg * 0.5
    + (texture2D(inkMask, uv + vec2(t.x, 0.0)).rg
    + texture2D(inkMask, uv - vec2(t.x, 0.0)).rg
    + texture2D(inkMask, uv + vec2(0.0, t.y)).rg
    + texture2D(inkMask, uv - vec2(0.0, t.y)).rg) * 0.125;
}

float coverageAt(vec2 uv) {
  vec2 ink = texture2D(inkMask, uv).rg;
  return smoothstep(0.26, 0.65, ink.r + ink.g);
}

void main(void) {
  vec2 p = vec2(dot(vPositionW, surfaceU), dot(vPositionW, surfaceV));
  vec2 mask = inkAt(vUV);
  float coverage = smoothstep(0.26, 0.65, mask.r + mask.g);
  vec3 inkColor = mix(team1Color, team0Color, smoothstep(-0.04, 0.04, mask.r - mask.g));
  float dx = coverageAt(vUV + vec2(texelSize.x, 0.0)) - coverageAt(vUV - vec2(texelSize.x, 0.0));
  float dy = coverageAt(vUV + vec2(0.0, texelSize.y)) - coverageAt(vUV - vec2(0.0, texelSize.y));
  // Raised meniscus and broad bumps give the settled film a wet surface.
  float waveX = cos(p.x * 4.4 + sin(p.y * 2.3)) * 0.06 + cos(p.x * 9.1 + p.y * 6.2) * 0.022;
  float waveY = cos(p.y * 4.0 + sin(p.x * 2.7)) * 0.05 + cos(p.x * 9.1 + p.y * 6.2) * 0.017;
  vec3 n = normalize(vNormalW - surfaceU * (dx * 0.024 / (texelSize.x * surfaceSize.x) + waveX * coverage)
    - surfaceV * (dy * 0.024 / (texelSize.y * surfaceSize.y) + waveY * coverage));
  vec3 view = normalize(cameraPosition - vPositionW);
  vec3 light = normalize(vec3(-0.45, 1.0, -0.3));
  vec3 halfVector = normalize(light + view);
  float diffuse = 0.48 + 0.52 * max(dot(n, light), 0.0);
  float specular = (pow(max(dot(n, halfVector), 0.0), 44.0) * 0.65
    + pow(max(dot(n, halfVector), 0.0), 140.0) * 0.8) * coverage;
  vec3 reflection = reflect(-view, n);
  float sky = smoothstep(-0.2, 0.85, reflection.y);
  float fresnel = 0.035 + 0.18 * pow(1.0 - max(dot(n, view), 0.0), 4.0);
  vec3 reflectedColor = mix(vec3(0.18, 0.23, 0.30), vec3(0.80, 0.88, 0.96), sky);
  float grain = fract(sin(dot(floor(p * 125.0), vec2(12.9898, 78.233))) * 43758.5453);
  vec2 seams = abs(fract(p / 2.0) - 0.5);
  float seam = max(smoothstep(0.492, 0.499, seams.x), smoothstep(0.492, 0.499, seams.y));
  vec3 concrete = neutralColor * (0.96 + grain * 0.055 - seam * 0.12);
  vec3 wet = inkColor * diffuse * (0.94 + 0.06 * sin(p.x * 3.0 + p.y * 2.5));
  wet = mix(wet, reflectedColor, fresnel) + vec3(specular);
  gl_FragColor = vec4(mix(concrete * diffuse, wet, coverage), 1.0);
}`;

export class InkTextureRenderer {
  private readonly surfaces = new Map<PaintSurfaceId, InkSurface>();
  private readonly dirty = new Set<InkSurface>();

  constructor(
    private readonly scene: Scene,
    level: LevelDefinition,
    teamColors: readonly [string, string],
    neutralColors: { ground: string; obstacle: string; arenaWall: string }
  ) {
    for (const floor of createLevelFloorSurfaces(level)) {
      const size = floor.id === "ground" ? { width: DEFAULT_INK_RESOLUTION, height: DEFAULT_INK_RESOLUTION } : floorInkGridSize(floor);
      this.surfaces.set(floor.id, this.createSurface(floor.id, size.width, size.height, false,
        neutralColors.ground, teamColors, new Vector3(1, 0, 0), new Vector3(0, 0, -1), floor.width, floor.depth));
    }
    for (const wall of createLevelWallSurfaces(level)) {
      const size = wallInkGridSize(wall);
      const invert = wall.axis === "x" ? wall.normalX < 0 : wall.normalZ > 0;
      const along = wall.axis === "x" ? new Vector3(0, 0, invert ? -1 : 1) : new Vector3(invert ? -1 : 1, 0, 0);
      this.surfaces.set(wall.id, this.createSurface(wall.id, size.width, size.height, invert,
        wall.id.startsWith("obstacle-") ? neutralColors.obstacle : neutralColors.arenaWall,
        teamColors, along, new Vector3(0, -1, 0), wall.maxAlong - wall.minAlong, wall.height));
    }
  }

  groundMaterial() { return this.surfaces.get("ground")!.material; }
  wallMaterial(id: PaintSurfaceId) { return this.surfaces.get(id)?.material; }

  applyTile(snapshot: InkTileSnapshot) {
    const surface = this.surfaces.get(snapshot.surfaceId);
    if (!surface || surface.width !== snapshot.gridWidth || surface.height !== snapshot.gridHeight) return;
    const context = surface.texture.getContext();
    for (let y = 0; y < snapshot.height; y++) for (let x = 0; x < snapshot.width; x++) {
      const logicalX = snapshot.tileX * snapshot.tileSize + x;
      const canvasX = surface.invertAlong ? surface.width - logicalX - 1 : logicalX;
      const canvasY = surface.height - snapshot.tileY * snapshot.tileSize - y - 1;
      const owner = snapshot.owners[y * snapshot.width + x];
      context.fillStyle = owner === 0 ? "#ff0000" : owner === 1 ? "#00ff00" : "#000000";
      context.fillRect(canvasX, canvasY, 1, 1);
    }
    this.dirty.add(surface);
  }

  applyTiles(snapshots: readonly InkTileSnapshot[]) { snapshots.forEach((tile) => this.applyTile(tile)); }

  update(_dt: number) {
    this.dirty.forEach((surface) => surface.texture.update(true));
    this.dirty.clear();
    const camera = this.scene.activeCamera;
    if (camera) this.surfaces.forEach((surface) => surface.material.setVector3("cameraPosition", camera.position));
  }

  private createSurface(id: PaintSurfaceId, width: number, height: number, invertAlong: boolean,
    neutralColor: string, teamColors: readonly [string, string], surfaceU: Vector3, surfaceV: Vector3, sizeU: number, sizeV: number): InkSurface {
    const texture = new DynamicTexture(`ink-mask-${id}`, { width, height }, this.scene, false, Texture.BILINEAR_SAMPLINGMODE);
    texture.wrapU = texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    const context = texture.getContext();
    context.fillStyle = "#000000";
    context.fillRect(0, 0, width, height);
    texture.update(true);
    const material = new ShaderMaterial(`ink-surface-${id}`, this.scene,
      { vertex: "inkSurface", fragment: "inkSurface" }, {
        attributes: ["position", "normal", "uv"],
        uniforms: ["world", "worldViewProjection", "texelSize", "surfaceSize", "neutralColor", "team0Color", "team1Color", "cameraPosition", "surfaceU", "surfaceV"],
        samplers: ["inkMask"]
      });
    material.setTexture("inkMask", texture);
    material.setVector2("texelSize", new Vector2(1 / width, 1 / height));
    material.setVector2("surfaceSize", new Vector2(sizeU, sizeV));
    material.setColor3("neutralColor", Color3.FromHexString(neutralColor));
    material.setColor3("team0Color", Color3.FromHexString(teamColors[0]));
    material.setColor3("team1Color", Color3.FromHexString(teamColors[1]));
    material.setVector3("cameraPosition", Vector3.Zero());
    material.setVector3("surfaceU", surfaceU);
    material.setVector3("surfaceV", surfaceV);
    return { texture, material, width, height, invertAlong };
  }
}
