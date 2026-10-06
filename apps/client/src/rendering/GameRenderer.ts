import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import type { BulletSnapshot, PaintStamp, PlayerSnapshot, TeamId } from "@tofu/protocol";
import type { InkTileSnapshot } from "@tofu/simulation/ink";
import { createLevelFloorSurfaces, type LevelDefinition, type WallSurface } from "@tofu/simulation/level";
import type { TargetSnapshot } from "@tofu/simulation/world";
import type { ThirdPersonCamera } from "../camera/ThirdPersonCamera";
import { InkFluidVfx } from "./InkFluidVfx";
import { InkTextureRenderer } from "./InkTextureRenderer";

export const TEAM_COLORS = [Color3.FromHexString("#ff632b"), Color3.FromHexString("#16b5ce")] as const;
const TEAM_COLOR_CSS = ["#ff632b", "#16b5ce"] as const;

type PlayerMesh = {
  root: TransformNode; standing: TransformNode; swimmer: Mesh; weapon: TransformNode;
  tankFill: Mesh; feet: readonly Mesh[]; flash: Mesh; shadow: Mesh;
  previousPosition: Vector3; targetPosition: Vector3; velocity: Vector3;
  targetYaw: number; aimPitch: number; diving: boolean; alive: boolean;
  walkPhase: number; recoil: number;
};
type BulletMesh = { mesh: Mesh; targetPosition: Vector3; velocity: Vector3 };
type TargetMesh = { root: TransformNode; material: StandardMaterial; label: DynamicTexture; hp: number; flash: number };

export class GameRenderer {
  private readonly playerMeshes = new Map<string, PlayerMesh>();
  private readonly bulletMeshes = new Map<string, BulletMesh>();
  private readonly targetMeshes = new Map<string, TargetMesh>();
  private readonly inkRenderer: InkTextureRenderer;
  private readonly inkVfx: InkFluidVfx;
  private readonly bulletMaterials: readonly StandardMaterial[];
  private readonly shadowMaterial: StandardMaterial;

  constructor(private readonly scene: Scene, private readonly level: LevelDefinition, private readonly wallSurfaces: readonly WallSurface[]) {
    scene.clearColor = new Color4(0.66, 0.79, 0.88, 1);
    scene.fogMode = Scene.FOGMODE_LINEAR;
    scene.fogStart = 36;
    scene.fogEnd = 95;
    scene.fogColor = new Color3(0.66, 0.79, 0.88);
    const ambient = new HemisphericLight("sky", new Vector3(0, 1, 0), scene);
    ambient.intensity = 0.8;
    ambient.groundColor = new Color3(0.27, 0.31, 0.39);
    const sun = new DirectionalLight("sun", new Vector3(0.45, -1, 0.3), scene);
    sun.intensity = 0.85;
    this.bulletMaterials = TEAM_COLORS.map((color, team) => {
      const material = this.makeMaterial(`ink-bullet-${team}`, color);
      material.specularColor = Color3.White();
      material.specularPower = 96;
      material.emissiveColor = color.scale(0.18);
      return material;
    });
    this.shadowMaterial = this.makeShadowMaterial();
    this.inkRenderer = new InkTextureRenderer(scene, level, TEAM_COLOR_CSS, {
      ground: "#b5bcc4", obstacle: "#8d9aa5", arenaWall: "#596574"
    });
    this.inkVfx = new InkFluidVfx(scene, wallSurfaces);
    this.createArena();
    for (const target of level.targets ?? []) this.createTarget(target);
  }

  syncPlayer(player: Readonly<PlayerSnapshot>, _local: boolean) {
    let view = this.playerMeshes.get(player.id);
    if (!view) {
      view = this.createTofu(player.id, player.team);
      view.root.position.set(player.x, player.y, player.z);
      view.previousPosition.copyFrom(view.root.position);
      view.targetPosition.copyFrom(view.root.position);
      view.root.rotation.y = Math.atan2(player.facingX, player.facingZ);
      this.playerMeshes.set(player.id, view);
    }
    view.previousPosition.copyFrom(view.targetPosition);
    view.targetPosition.set(player.x, player.y, player.z);
    if (Vector3.DistanceSquared(view.previousPosition, view.targetPosition) > 9) {
      view.previousPosition.copyFrom(view.targetPosition);
      view.root.position.copyFrom(view.targetPosition);
    }
    view.velocity.set(player.vx, player.vy, player.vz);
    view.targetYaw = Math.atan2(player.facingX, player.facingZ);
    view.aimPitch = player.aimPitch;
    view.diving = player.diving;
    view.alive = player.alive;
    view.standing.setEnabled(!player.diving && player.alive);
    view.swimmer.setEnabled(player.diving && player.alive);
    view.swimmer.rotation.x = player.wallAttached ? Math.PI / 2 : 0;
    view.swimmer.position.y = player.wallAttached ? 0.25 : 0.11;
    view.shadow.setEnabled(player.alive && !player.wallAttached);
    view.tankFill.scaling.y = Math.max(0.03, player.ink / 100);
    view.tankFill.position.y = 0.59 + player.ink / 100 * 0.22;
  }

  shootEffect(ownerId: string) {
    const view = this.playerMeshes.get(ownerId);
    if (!view) return;
    view.recoil = 1;
    view.root.rotation.y = view.targetYaw;
    view.flash.setEnabled(true);
  }

  syncTargets(targets: Iterable<Readonly<TargetSnapshot>>) {
    for (const target of targets) {
      const view = this.targetMeshes.get(target.id);
      if (!view || view.hp === target.hp) continue;
      view.flash = target.hp < view.hp ? 1 : 0;
      view.hp = target.hp;
      view.root.scaling.y = target.hp === 0 ? 0.15 : 1;
      this.drawTargetLabel(view);
    }
  }

  syncBullet(bullet: Readonly<BulletSnapshot>) {
    let view = this.bulletMeshes.get(bullet.id);
    if (!view) {
      const mesh = MeshBuilder.CreateSphere(`bullet-${bullet.id}`, { diameter: bullet.kind === "droplet" ? 0.13 : 0.23, segments: 10 }, this.scene);
      mesh.material = this.bulletMaterials[bullet.team];
      mesh.isPickable = false;
      mesh.scaling.set(0.85, 0.85, bullet.kind === "droplet" ? 1.1 : 1.75);
      mesh.position.set(bullet.x, bullet.y, bullet.z);
      view = { mesh, targetPosition: mesh.position.clone(), velocity: Vector3.Zero() };
      this.bulletMeshes.set(bullet.id, view);
    }
    view.targetPosition.set(bullet.x, bullet.y, bullet.z);
    view.velocity.set(bullet.dx, bullet.dy, bullet.dz);
    view.mesh.rotationQuaternion = Quaternion.FromLookDirectionLH(view.velocity.normalizeToNew(), Vector3.Up());
  }

  update(dt: number, localPlayerId: string, alpha: number) {
    this.inkRenderer.update(dt);
    this.inkVfx.update(dt);
    const blend = 1 - Math.exp(-20 * dt);
    this.playerMeshes.forEach((view, id) => {
      if (id === localPlayerId) Vector3.LerpToRef(view.previousPosition, view.targetPosition, alpha, view.root.position);
      else {
        const predicted = view.targetPosition.add(view.velocity.scale(0.04));
        Vector3.LerpToRef(view.root.position, predicted, blend, view.root.position);
      }
      if (id === localPlayerId && this.scene.activeCamera) {
        const distance = Vector3.Distance(this.scene.activeCamera.position, view.root.position.add(new Vector3(0, 1, 0)));
        const visibility = Math.max(0.18, Math.min(1, (distance - 0.75) / 1.25));
        view.standing.getChildMeshes().forEach((mesh) => mesh.visibility = visibility);
      }
      view.root.rotation.y = lerpAngle(view.root.rotation.y, view.targetYaw, 1 - Math.exp(-28 * dt));
      const speed = Math.hypot(view.velocity.x, view.velocity.z);
      view.walkPhase += speed * dt * 3.1;
      const gait = Math.min(1, speed / 3);
      view.feet.forEach((foot, index) => {
        foot.position.z = Math.sin(view.walkPhase + index * Math.PI) * 0.14 * gait;
        foot.position.y = 0.10 + Math.max(0, Math.cos(view.walkPhase + index * Math.PI)) * 0.075 * gait;
      });
      view.standing.rotation.z = Math.sin(view.walkPhase) * gait * 0.025;
      view.swimmer.scaling.z = 1.2 + Math.sin(view.walkPhase * 1.3) * 0.08 * gait;
      view.weapon.rotation.x = -view.aimPitch - view.recoil * 0.08;
      view.weapon.position.z = 0.20 - view.recoil * 0.06;
      view.recoil = Math.max(0, view.recoil - dt * 14);
      if (view.recoil < 0.2) view.flash.setEnabled(false);
    });
    this.bulletMeshes.forEach((view) => Vector3.LerpToRef(view.mesh.position, view.targetPosition, 1 - Math.exp(-55 * dt), view.mesh.position));
    this.targetMeshes.forEach((view) => {
      view.flash = Math.max(0, view.flash - dt * 7);
      view.material.emissiveColor.set(view.flash * 0.6, view.flash * 0.23, view.flash * 0.08);
    });
  }

  followLocalPlayer(camera: ThirdPersonCamera, id: string) {
    const view = this.playerMeshes.get(id);
    if (view) camera.follow(view.root);
  }

  applyInkTile(tile: InkTileSnapshot) { this.inkRenderer.applyTile(tile); }
  applyPaint(stamps: readonly PaintStamp[], tiles: readonly InkTileSnapshot[]) {
    this.inkVfx.spawn(stamps);
    this.inkRenderer.applyTiles(tiles);
  }
  removePlayer(id: string) { this.playerMeshes.get(id)?.root.dispose(); this.playerMeshes.delete(id); }
  removeBullet(id: string) { this.bulletMeshes.get(id)?.mesh.dispose(); this.bulletMeshes.delete(id); }
  pruneBullets(existing: ReadonlyMap<string, Readonly<BulletSnapshot>>) {
    for (const id of this.bulletMeshes.keys()) if (!existing.has(id)) this.removeBullet(id);
  }
  dispose() { this.inkVfx.dispose(); }

  private createArena() {
    for (const surface of createLevelFloorSurfaces(this.level)) {
      const floor = MeshBuilder.CreateGround(surface.id === "ground" ? "paintable-floor" : `paintable-${surface.id}`,
        { width: surface.width, height: surface.depth, subdivisions: surface.id === "ground" ? 100 : 16 }, this.scene);
      floor.position.set(surface.x, surface.y + (surface.id === "ground" ? 0 : 0.008), surface.z);
      floor.material = this.inkRenderer.wallMaterial(surface.id) ?? null;
    }
    const wallMaterial = this.makeMaterial("arena-concrete", Color3.FromHexString("#596574"));
    const trim = this.makeMaterial("trim", Color3.FromHexString("#d9e0e4"));
    const dark = this.makeMaterial("roof-edge", Color3.FromHexString("#283846"));
    const size = this.level.halfSize * 2 + 0.6;
    const walls = [
      { x: 0, z: -this.level.halfSize - 0.15, width: size, depth: 0.3 },
      { x: 0, z: this.level.halfSize + 0.15, width: size, depth: 0.3 },
      { x: -this.level.halfSize - 0.15, z: 0, width: 0.3, depth: size },
      { x: this.level.halfSize + 0.15, z: 0, width: 0.3, depth: size }
    ];
    walls.forEach((wall, i) => {
      this.box(`wall-${i}`, wall.width, this.level.arenaWallHeight, wall.depth, wall.x, this.level.arenaWallHeight / 2, wall.z, wallMaterial);
      this.box(`railing-${i}`, wall.width + 0.07, 0.08, wall.depth + 0.07, wall.x, this.level.arenaWallHeight + 0.04, wall.z, trim).isPickable = false;
    });
    this.box("roof-slab", size + 0.4, 0.7, size + 0.4, 0, -0.42, 0, dark).isPickable = false;
    const cover = this.makeMaterial("cover-concrete", Color3.FromHexString("#8d9aa5"));
    this.level.obstacles.forEach((box, index) => {
      this.box(`cover-${index}`, box.width, box.height, box.depth, box.x, box.height / 2, box.z, cover);
      const shadow = MeshBuilder.CreateGround(`cover-shadow-${index}`, { width: box.width + 1.3, height: box.depth + 1.3 }, this.scene);
      shadow.position.set(box.x, 0.035, box.z); shadow.material = this.shadowMaterial; shadow.isPickable = false;
      // Capped rails sit above the paintable sides and help read each ledge.
      this.box(`ledge-${index}`, box.width + 0.05, 0.055, 0.08, box.x, box.height + 0.035, box.z - box.depth / 2, trim).isPickable = false;
    });
    this.wallSurfaces.forEach((surface) => {
      const plane = MeshBuilder.CreatePlane(`paint-surface-${surface.id}`, { width: surface.maxAlong - surface.minAlong, height: surface.height }, this.scene);
      const along = (surface.minAlong + surface.maxAlong) / 2;
      if (surface.axis === "x") {
        plane.position.set(surface.coordinate + surface.normalX * 0.009, surface.height / 2, along);
        plane.rotation.y = surface.normalX < 0 ? Math.PI / 2 : -Math.PI / 2;
      } else {
        plane.position.set(along, surface.height / 2, surface.coordinate + surface.normalZ * 0.009);
        plane.rotation.y = surface.normalZ < 0 ? 0 : Math.PI;
      }
      plane.material = this.inkRenderer.wallMaterial(surface.id) ?? null;
    });
    for (let i = 0; i < 20; i++) {
      const angle = i / 20 * Math.PI * 2;
      const distance = 43 + i % 3 * 8;
      const height = 7 + i * 7 % 19;
      const city = this.makeMaterial(`city-${i}`, new Color3(0.43 + i % 3 * 0.05, 0.53 + i % 2 * 0.04, 0.62));
      this.box(`city-${i}`, 6 + i % 3 * 3, height, 6, Math.sin(angle) * distance, height / 2 - 6, Math.cos(angle) * distance, city).isPickable = false;
    }
    this.createSign();
    for (const [team, spawns] of Object.entries(this.level.spawns)) {
      const spawn = spawns[0];
      const ring = MeshBuilder.CreateTorus(`spawn-${team}`, { diameter: 2.5, thickness: 0.035, tessellation: 40 }, this.scene);
      ring.position.set(spawn.x, 0.035, spawn.z);
      ring.material = this.bulletMaterials[Number(team)];
      ring.isPickable = false;
    }
  }

  private createTofu(id: string, team: TeamId): PlayerMesh {
    const root = new TransformNode(`tofu-${id}`, this.scene);
    const standing = new TransformNode(`standing-${id}`, this.scene);
    standing.parent = root;
    const white = this.makeMaterial(`tofu-white-${id}`, Color3.FromHexString("#f5f0dd"));
    const ink = this.makeMaterial(`tofu-team-${id}`, TEAM_COLORS[team]);
    const dark = this.makeMaterial(`tofu-dark-${id}`, Color3.FromHexString("#23323d"));
    const body = this.roundedBox(`jacket-${id}`, 0.54, 0.50, 0.40, 0.07, ink);
    body.parent = standing; body.position.y = 0.57;
    const head = this.roundedBox(`head-${id}`, 0.66, 0.45, 0.51, 0.08, white);
    head.parent = standing; head.position.set(0, 1.0, 0.015);
    const band = this.roundedBox(`band-${id}`, 0.685, 0.095, 0.53, 0.02, dark);
    band.parent = standing; band.position.y = 1.075;
    for (const x of [-0.15, 0.15]) {
      const eye = MeshBuilder.CreateSphere(`eye-${id}-${x}`, { diameter: 0.105, segments: 12 }, this.scene);
      eye.parent = standing; eye.position.set(x, 0.96, 0.263); eye.scaling.z = 0.35; eye.material = dark;
      const arm = this.roundedBox(`arm-${id}-${x}`, 0.16, 0.35, 0.18, 0.05, white);
      arm.parent = standing; arm.position.set(x < 0 ? -0.34 : 0.34, 0.61, x < 0 ? 0.05 : 0.22); arm.rotation.x = -0.4;
    }
    const feet = [-0.16, 0.16].map((x) => {
      const shoe = this.roundedBox(`shoe-${id}-${x}`, 0.23, 0.20, 0.35, 0.045, dark);
      shoe.parent = standing; shoe.position.set(x, 0.10, 0);
      const leg = this.roundedBox(`leg-${id}-${x}`, 0.16, 0.22, 0.16, 0.035, white);
      leg.parent = standing; leg.position.set(x, 0.29, 0);
      return shoe;
    });
    const tank = this.roundedBox(`tank-${id}`, 0.31, 0.54, 0.22, 0.06, dark);
    tank.parent = standing; tank.position.set(-0.08, 0.80, -0.28);
    const tankFill = this.roundedBox(`tank-fill-${id}`, 0.21, 0.44, 0.04, 0.015, ink);
    tankFill.parent = standing; tankFill.position.set(-0.08, 0.81, -0.40);
    const weapon = new TransformNode(`weapon-${id}`, this.scene);
    weapon.parent = standing; weapon.position.set(0.34, 0.82, 0.20);
    const green = this.makeMaterial(`weapon-green-${id}`, Color3.FromHexString("#b3e941"));
    const gun = this.roundedBox(`gun-${id}`, 0.23, 0.25, 0.42, 0.04, green);
    gun.parent = weapon; gun.position.z = 0.15;
    const grip = this.roundedBox(`grip-${id}`, 0.12, 0.25, 0.14, 0.02, dark);
    grip.parent = weapon; grip.position.set(0, -0.16, 0.08); grip.rotation.x = -0.25;
    const nozzle = MeshBuilder.CreateCylinder(`nozzle-${id}`, { height: 0.27, diameter: 0.14, tessellation: 14 }, this.scene);
    nozzle.parent = weapon; nozzle.rotation.x = Math.PI / 2; nozzle.position.z = 0.40; nozzle.material = dark;
    const bottle = MeshBuilder.CreateSphere(`gun-bottle-${id}`, { diameter: 0.21, segments: 12 }, this.scene);
    bottle.parent = weapon; bottle.position.set(0, 0.18, 0.09); bottle.material = ink; bottle.scaling.z = 1.25;
    const flash = MeshBuilder.CreateSphere(`muzzle-${id}`, { diameter: 0.20, segments: 8 }, this.scene);
    flash.parent = weapon; flash.position.z = 0.58; flash.material = this.bulletMaterials[team]; flash.setEnabled(false);
    const swimmer = MeshBuilder.CreateSphere(`swimmer-${id}`, { diameter: 0.66, segments: 20 }, this.scene);
    swimmer.parent = root; swimmer.position.y = 0.11; swimmer.scaling.set(0.9, 0.28, 1.2); swimmer.material = this.bulletMaterials[team]; swimmer.setEnabled(false);
    const shadow = MeshBuilder.CreateGround(`contact-shadow-${id}`, { width: 1.1, height: 1.1 }, this.scene);
    shadow.parent = root; shadow.position.y = 0.042; shadow.material = this.shadowMaterial; shadow.isPickable = false;
    return { root, standing, swimmer, weapon, feet, tankFill, flash, shadow,
      previousPosition: Vector3.Zero(), targetPosition: Vector3.Zero(), velocity: Vector3.Zero(),
      targetYaw: 0, aimPitch: 0, diving: false, alive: true, walkPhase: 0, recoil: 0 };
  }

  private createTarget(target: { id: string; x: number; y: number; z: number }) {
    const root = new TransformNode(target.id, this.scene);
    root.position.set(target.x, target.y, target.z);
    const material = this.makeMaterial(`target-${target.id}`, Color3.FromHexString("#d6dfc8"));
    const body = MeshBuilder.CreateCapsule(`target-body-${target.id}`, { height: 1.3, radius: 0.37, tessellation: 16, subdivisions: 2 }, this.scene);
    body.parent = root; body.position.y = 0.65; body.material = material;
    const dark = this.makeMaterial(`target-ring-${target.id}`, Color3.FromHexString("#344553"));
    const ring = MeshBuilder.CreateTorus(`bullseye-${target.id}`, { diameter: 0.40, thickness: 0.055, tessellation: 24 }, this.scene);
    ring.parent = root; ring.position.set(0, 0.78, -0.365); ring.rotation.x = Math.PI / 2; ring.material = dark;
    const spot = MeshBuilder.CreateSphere(`bullseye-center-${target.id}`, { diameter: 0.12, segments: 12 }, this.scene);
    spot.parent = root; spot.position.set(0, 0.78, -0.39); spot.scaling.z = 0.2; spot.material = dark;
    const label = new DynamicTexture(`target-label-${target.id}`, { width: 256, height: 80 }, this.scene, false);
    label.hasAlpha = true;
    const labelMaterial = this.makeMaterial(`target-label-material-${target.id}`, Color3.White());
    labelMaterial.diffuseTexture = label; labelMaterial.emissiveTexture = label; labelMaterial.emissiveColor = Color3.White();
    labelMaterial.useAlphaFromDiffuseTexture = true; labelMaterial.disableLighting = true;
    const plane = MeshBuilder.CreatePlane(`target-label-${target.id}`, { width: 1.05, height: 0.33 }, this.scene);
    plane.parent = root; plane.position.y = 1.65; plane.billboardMode = Mesh.BILLBOARDMODE_ALL; plane.material = labelMaterial; plane.isPickable = false;
    const view = { root, material, label, hp: 100, flash: 0 };
    const shadow = MeshBuilder.CreateGround(`target-shadow-${target.id}`, { width: 1.1, height: 1.1 }, this.scene);
    shadow.position.set(target.x, target.y + 0.04, target.z); shadow.material = this.shadowMaterial; shadow.isPickable = false;
    this.targetMeshes.set(target.id, view);
    this.drawTargetLabel(view);
  }

  private drawTargetLabel(view: TargetMesh) {
    const ctx = view.label.getContext();
    ctx.clearRect(0, 0, 256, 80);
    ctx.fillStyle = "#20303ee6"; ctx.fillRect(4, 8, 248, 64);
    ctx.fillStyle = view.hp === 0 ? "#ffba54" : "#edf5f6";
    ctx.font = "bold 30px system-ui";
    const text = view.hp === 0 ? "SPLAT!" : view.hp === 100 ? "100 HP" : `${100 - view.hp} DAMAGE`;
    ctx.fillText(text, (256 - ctx.measureText(text).width) / 2, 48);
    view.label.update();
  }

  private createSign() {
    const texture = new DynamicTexture("yard-sign", { width: 1024, height: 256 }, this.scene, false);
    const ctx = texture.getContext();
    ctx.fillStyle = "#243542"; ctx.fillRect(0, 0, 1024, 256);
    ctx.fillStyle = "#b4ee3e"; ctx.fillRect(0, 0, 24, 256);
    ctx.fillStyle = "#eef4f2"; ctx.font = "900 102px system-ui"; ctx.fillText("TOFU YARD", 68, 130);
    ctx.fillStyle = "#8fa9b8"; ctx.font = "25px monospace"; ctx.fillText("INK IT. SWIM IT. MAKE IT YOURS.", 74, 204);
    texture.update();
    const material = this.makeMaterial("sign", Color3.White());
    material.diffuseTexture = texture; material.emissiveTexture = texture; material.emissiveColor = Color3.White(); material.disableLighting = true;
    const sign = MeshBuilder.CreatePlane("yard-sign", { width: 9, height: 2.25 }, this.scene);
    sign.position.set(0, 4.1, this.level.halfSize + 1.5); sign.material = material; sign.isPickable = false;
  }

  private roundedBox(name: string, width: number, height: number, depth: number, bevel: number, material: StandardMaterial) {
    const mesh = MeshBuilder.CreateSphere(name, { diameter: 2, segments: 16 }, this.scene);
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i], y = positions[i + 1], z = positions[i + 2];
      const max = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
      positions[i] = x / max * (width / 2 - bevel) + x * bevel;
      positions[i + 1] = y / max * (height / 2 - bevel) + y * bevel;
      positions[i + 2] = z / max * (depth / 2 - bevel) + z * bevel;
    }
    mesh.setVerticesData(VertexBuffer.PositionKind, positions);
    mesh.refreshBoundingInfo(); mesh.material = material;
    return mesh;
  }

  private box(name: string, width: number, height: number, depth: number, x: number, y: number, z: number, material: StandardMaterial) {
    const mesh = MeshBuilder.CreateBox(name, { width, height, depth }, this.scene);
    mesh.position.set(x, y, z); mesh.material = material;
    return mesh;
  }

  private makeMaterial(name: string, color: Color3) {
    const material = new StandardMaterial(name, this.scene);
    material.diffuseColor = color;
    material.specularColor = new Color3(0.15, 0.17, 0.19);
    material.specularPower = 48;
    return material;
  }

  private makeShadowMaterial() {
    const texture = new DynamicTexture("contact-shadow", 64, this.scene, false);
    texture.hasAlpha = true;
    const ctx = texture.getContext();
    const gradient = ctx.createRadialGradient(32, 32, 4, 32, 32, 32);
    gradient.addColorStop(0, "rgba(15,25,35,0.3)"); gradient.addColorStop(1, "rgba(15,25,35,0)");
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 64, 64); texture.update();
    const material = this.makeMaterial("contact-shadow", Color3.White());
    material.diffuseTexture = texture; material.emissiveTexture = texture; material.emissiveColor = Color3.White();
    material.useAlphaFromDiffuseTexture = true; material.disableLighting = true;
    return material;
  }
}

function lerpAngle(current: number, target: number, amount: number) {
  return current + Math.atan2(Math.sin(target - current), Math.cos(target - current)) * amount;
}
