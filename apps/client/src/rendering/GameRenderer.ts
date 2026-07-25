import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { BulletSnapshot, PaintStamp, PlayerSnapshot, TeamId } from "@tofu/protocol";
import type { InkTileSnapshot } from "@tofu/simulation/ink";
import type { LevelDefinition, WallSurface } from "@tofu/simulation/level";
import type { ThirdPersonCamera } from "../camera/ThirdPersonCamera";
import { InkTextureRenderer } from "./InkTextureRenderer";

type PlayerMesh = {
  root: TransformNode;
  material: StandardMaterial;
  targetPosition: Vector3;
  velocity: Vector3;
  targetYaw: number;
  diving: boolean;
};

type BulletMesh = {
  mesh: Mesh;
  targetPosition: Vector3;
};

const TEAM_COLORS = [new Color3(0.96, 0.36, 0.12), new Color3(0.08, 0.64, 0.68)] as const;
const TEAM_COLOR_CSS = ["#f45c1f", "#14a3ad"] as const;
const NEUTRAL_GROUND_COLOR = "#b9c2ad";
const NEUTRAL_COVER_COLOR = "#84917f";
const NEUTRAL_ARENA_WALL_COLOR = "#1f2e24";
const INK_TEXTURE_SIZE = 512;
const PLAYER_RENDER_SHARPNESS = 18;
const PLAYER_ROTATION_SHARPNESS = 20;
const NETWORK_EXTRAPOLATION_SECONDS = 0.05;
const BULLET_RENDER_SHARPNESS = 30;

export class GameRenderer {
  private readonly playerMeshes = new Map<string, PlayerMesh>();
  private readonly bulletMeshes = new Map<string, BulletMesh>();
  private readonly wallInkTextures = new Map<string, DynamicTexture>();
  private readonly inkRenderer: InkTextureRenderer;
  private inkTexture!: DynamicTexture;

  constructor(
    private readonly scene: Scene,
    private readonly level: LevelDefinition,
    private readonly wallSurfaces: readonly WallSurface[]
  ) {
    scene.clearColor = new Color4(0.79, 0.89, 0.82, 1);
    const light = new HemisphericLight("sun", new Vector3(-0.3, 1, -0.2), scene);
    light.intensity = 1.25;
    light.groundColor = new Color3(0.35, 0.45, 0.38);
    this.createArena();
    this.inkRenderer = new InkTextureRenderer(
      this.inkTexture,
      this.wallInkTextures,
      INK_TEXTURE_SIZE,
      TEAM_COLOR_CSS,
      level.halfSize,
      wallSurfaces,
      {
        ground: NEUTRAL_GROUND_COLOR,
        obstacle: NEUTRAL_COVER_COLOR,
        arenaWall: NEUTRAL_ARENA_WALL_COLOR
      }
    );
  }

  syncPlayer(player: PlayerSnapshot, local: boolean) {
    let view = this.playerMeshes.get(player.id);
    if (!view) {
      view = this.createTofu(player.id, player.team);
      view.root.position.set(player.x, player.y, player.z);
      this.playerMeshes.set(player.id, view);
    }
    const nextPosition = new Vector3(player.x, player.y, player.z);
    if (Vector3.DistanceSquared(view.targetPosition, nextPosition) > 16) view.root.position.copyFrom(nextPosition);
    view.targetPosition.copyFrom(nextPosition);
    view.velocity.set(player.vx, player.vy, player.vz);
    view.targetYaw = Math.atan2(player.facingX, player.facingZ);
    view.diving = player.diving;
    view.root.scaling.copyFrom(
      player.alive
        ? player.diving ? new Vector3(0.78, 0.32, 1.08) : Vector3.One()
        : new Vector3(1, 0.18, 1)
    );
    view.material.alpha = player.alive ? local ? 1 : 0.92 : 0.48;
  }

  syncBullet(bullet: BulletSnapshot) {
    let view = this.bulletMeshes.get(bullet.id);
    if (!view) {
      view = this.createBullet(bullet.id, bullet.team);
      view.mesh.position.set(bullet.x, bullet.y, bullet.z);
      this.bulletMeshes.set(bullet.id, view);
    }
    view.targetPosition.set(bullet.x, bullet.y, bullet.z);
  }

  update(dt: number, localPlayerId: string) {
    const positionBlend = 1 - Math.exp(-PLAYER_RENDER_SHARPNESS * dt);
    const rotationBlend = 1 - Math.exp(-PLAYER_ROTATION_SHARPNESS * dt);
    this.playerMeshes.forEach((view, id) => {
      const predicted = view.targetPosition.add(
        view.velocity.scale(id === localPlayerId ? 0 : NETWORK_EXTRAPOLATION_SECONDS)
      );
      if (id === localPlayerId) view.root.position.copyFrom(predicted);
      else view.root.position.copyFrom(Vector3.Lerp(view.root.position, predicted, positionBlend));
      view.root.rotation.y = lerpAngle(view.root.rotation.y, view.targetYaw, rotationBlend);
    });

    const bulletBlend = 1 - Math.exp(-BULLET_RENDER_SHARPNESS * dt);
    this.bulletMeshes.forEach((view) => {
      view.mesh.position.copyFrom(Vector3.Lerp(view.mesh.position, view.targetPosition, bulletBlend));
    });
  }

  followLocalPlayer(camera: ThirdPersonCamera, localPlayerId: string) {
    const localView = this.playerMeshes.get(localPlayerId);
    if (localView) camera.follow(localView.root, localView.diving);
  }

  applyPaintStamp(stamp: PaintStamp) {
    this.inkRenderer.applyStamp(stamp);
  }

  applyInkTile(snapshot: InkTileSnapshot) {
    this.inkRenderer.applyTile(snapshot);
  }

  removePlayer(id: string) {
    this.playerMeshes.get(id)?.root.dispose();
    this.playerMeshes.delete(id);
  }

  removeBullet(id: string) {
    this.bulletMeshes.get(id)?.mesh.dispose();
    this.bulletMeshes.delete(id);
  }

  pruneBullets(existing: ReadonlyMap<string, BulletSnapshot>) {
    for (const id of this.bulletMeshes.keys()) {
      if (!existing.has(id)) this.removeBullet(id);
    }
  }

  private createArena() {
    const floorSize = this.level.halfSize * 2 + 3;
    const floor = MeshBuilder.CreateGround("paintable-floor", { width: floorSize, height: floorSize }, this.scene);
    const floorMaterial = new StandardMaterial("paintable-floor-material", this.scene);
    this.inkTexture = new DynamicTexture(
      "ink-ownership-texture",
      { width: INK_TEXTURE_SIZE, height: INK_TEXTURE_SIZE },
      this.scene,
      false
    );
    const inkContext = this.inkTexture.getContext();
    inkContext.fillStyle = NEUTRAL_GROUND_COLOR;
    inkContext.fillRect(0, 0, INK_TEXTURE_SIZE, INK_TEXTURE_SIZE);
    this.inkTexture.update(true);
    floorMaterial.diffuseTexture = this.inkTexture;
    floorMaterial.specularColor = new Color3(0.08, 0.08, 0.07);
    floor.material = floorMaterial;

    const wallMaterial = this.makeMaterial("wall-material", new Color3(0.12, 0.18, 0.14));
    const size = this.level.halfSize * 2 + 1;
    const walls = [
      { x: 0, z: -this.level.halfSize - 0.25, width: size, depth: 0.5 },
      { x: 0, z: this.level.halfSize + 0.25, width: size, depth: 0.5 },
      { x: -this.level.halfSize - 0.25, z: 0, width: 0.5, depth: size },
      { x: this.level.halfSize + 0.25, z: 0, width: 0.5, depth: size }
    ];
    walls.forEach((wall, index) => {
      const mesh = MeshBuilder.CreateBox(
        `wall-${index}`,
        { width: wall.width, depth: wall.depth, height: this.level.arenaWallHeight },
        this.scene
      );
      mesh.position.set(wall.x, this.level.arenaWallHeight / 2, wall.z);
      mesh.material = wallMaterial;
    });
    this.level.obstacles.forEach((box, index) => {
      const mesh = MeshBuilder.CreateBox(
        `cover-${index}`,
        { width: box.width, depth: box.depth, height: box.height },
        this.scene
      );
      mesh.position.set(box.x, box.height / 2, box.z);
      mesh.material = this.makeMaterial(`cover-${index}-material`, new Color3(0.52, 0.57, 0.5));
    });
    this.wallSurfaces.forEach((surface) => this.createWallPaintSurface(surface));
  }

  private createWallPaintSurface(surface: WallSurface) {
    const width = surface.maxAlong - surface.minAlong;
    const plane = MeshBuilder.CreatePlane(`paint-surface-${surface.id}`, {
      width,
      height: surface.height,
      sideOrientation: Mesh.FRONTSIDE
    }, this.scene);
    const alongCenter = (surface.minAlong + surface.maxAlong) / 2;
    if (surface.axis === "x") {
      plane.position.set(surface.coordinate + surface.normalX * 0.012, surface.height / 2, alongCenter);
      plane.rotation.y = surface.normalX < 0 ? Math.PI / 2 : -Math.PI / 2;
    } else {
      plane.position.set(alongCenter, surface.height / 2, surface.coordinate + surface.normalZ * 0.012);
      plane.rotation.y = surface.normalZ < 0 ? 0 : Math.PI;
    }
    const texture = new DynamicTexture(
      `wall-ink-${surface.id}`,
      { width: INK_TEXTURE_SIZE, height: INK_TEXTURE_SIZE },
      this.scene,
      false
    );
    const context = texture.getContext();
    context.fillStyle = surface.id.startsWith("obstacle-") ? NEUTRAL_COVER_COLOR : NEUTRAL_ARENA_WALL_COLOR;
    context.fillRect(0, 0, INK_TEXTURE_SIZE, INK_TEXTURE_SIZE);
    texture.update(true);
    const material = new StandardMaterial(`wall-ink-material-${surface.id}`, this.scene);
    material.diffuseTexture = texture;
    material.backFaceCulling = true;
    material.specularColor = new Color3(0.06, 0.07, 0.06);
    plane.material = material;
    this.wallInkTextures.set(surface.id, texture);
  }

  private createTofu(id: string, team: TeamId): PlayerMesh {
    const root = new TransformNode(`tofu-${id}`, this.scene);
    const body = MeshBuilder.CreateBox(`body-${id}`, { width: 0.82, height: 1.18, depth: 0.72 }, this.scene);
    body.parent = root;
    body.position.y = 0.61;
    const material = this.makeMaterial(`tofu-material-${id}`, TEAM_COLORS[team]);
    body.material = material;
    const eyeMaterial = this.makeMaterial(`eyes-${id}`, new Color3(0.08, 0.1, 0.08));
    for (const x of [-0.18, 0.18]) {
      const eye = MeshBuilder.CreateSphere(`eye-${id}-${x}`, { diameter: 0.1, segments: 8 }, this.scene);
      eye.parent = root;
      eye.position.set(x, 0.77, 0.37);
      eye.material = eyeMaterial;
    }
    const band = MeshBuilder.CreateBox(`band-${id}`, { width: 0.88, height: 0.13, depth: 0.78 }, this.scene);
    band.parent = root;
    band.position.y = 0.99;
    band.material = this.makeMaterial(`band-material-${id}`, TEAM_COLORS[team === 0 ? 1 : 0].scale(0.7));
    const weaponGreen = this.makeMaterial(`splattershot-green-${id}`, new Color3(0.48, 0.82, 0.12));
    const weaponDark = this.makeMaterial(`splattershot-dark-${id}`, new Color3(0.09, 0.2, 0.07));
    const weaponBody = MeshBuilder.CreateBox(
      `splattershot-body-${id}`,
      { width: 0.22, height: 0.24, depth: 0.48 },
      this.scene
    );
    weaponBody.parent = root;
    weaponBody.position.set(0.34, 0.77, 0.43);
    weaponBody.material = weaponGreen;
    const weaponTank = MeshBuilder.CreateSphere(
      `splattershot-tank-${id}`,
      { diameter: 0.2, segments: 8 },
      this.scene
    );
    weaponTank.parent = root;
    weaponTank.scaling.z = 1.35;
    weaponTank.position.set(0.34, 0.91, 0.28);
    weaponTank.material = band.material;
    const weaponGrip = MeshBuilder.CreateBox(
      `splattershot-grip-${id}`,
      { width: 0.13, height: 0.25, depth: 0.13 },
      this.scene
    );
    weaponGrip.parent = root;
    weaponGrip.position.set(0.34, 0.61, 0.35);
    weaponGrip.rotation.x = -0.25;
    weaponGrip.material = weaponDark;
    const nozzle = MeshBuilder.CreateCylinder(
      `splattershot-nozzle-${id}`,
      { height: 0.36, diameter: 0.14, tessellation: 10 },
      this.scene
    );
    nozzle.parent = root;
    nozzle.position.set(0.34, 0.79, 0.68);
    nozzle.rotation.x = Math.PI / 2;
    nozzle.material = weaponDark;
    return {
      root,
      material,
      targetPosition: Vector3.Zero(),
      velocity: Vector3.Zero(),
      targetYaw: 0,
      diving: false
    };
  }

  private createBullet(id: string, team: TeamId): BulletMesh {
    const bullet = MeshBuilder.CreateSphere(`soy-bullet-${id}`, { diameter: 0.26, segments: 10 }, this.scene);
    const material = this.makeMaterial(`bullet-material-${id}`, TEAM_COLORS[team]);
    material.emissiveColor = material.diffuseColor.scale(0.55);
    bullet.material = material;
    return { mesh: bullet, targetPosition: Vector3.Zero() };
  }

  private makeMaterial(name: string, color: Color3) {
    const material = new StandardMaterial(name, this.scene);
    material.diffuseColor = color;
    material.specularColor = new Color3(0.08, 0.08, 0.07);
    return material;
  }
}

function lerpAngle(current: number, target: number, amount: number) {
  const difference = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + difference * amount;
}
