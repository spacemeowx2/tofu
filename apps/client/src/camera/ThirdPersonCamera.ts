import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Ray } from "@babylonjs/core/Culling/ray";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { PlayerSnapshot } from "@tofu/protocol";
import type { WeaponDefinition } from "@tofu/simulation/weapons";

const CAMERA_SENSITIVITY = 0.0024;
const CAMERA_DISTANCE = 6.8;
const PLAYER_HEAD_HEIGHT = 1;
const CAMERA_VERTICAL_OFFSET = 0.58;
const AIM_DISTANCE = 45;

export class ThirdPersonCamera {
  readonly camera: FreeCamera;
  private yaw = 0;
  private pitch = -0.24;
  private aim = new Vector3(0, 0, 1);

  constructor(private readonly scene: Scene) {
    this.camera = new FreeCamera("camera", new Vector3(0, 2.85, -5.5), scene);
    this.camera.minZ = 0.1;
    this.camera.fov = 0.9;
    this.camera.inputs.clear();
  }

  look(deltaX: number, deltaY: number) {
    this.yaw += deltaX * CAMERA_SENSITIVITY;
    this.pitch = Math.max(-0.75, Math.min(0.08, this.pitch - deltaY * CAMERA_SENSITIVITY));
  }

  forward() {
    return new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  right() {
    const forward = this.forward();
    return new Vector3(forward.z, 0, -forward.x);
  }

  viewDirection() {
    const horizontalScale = Math.cos(this.pitch);
    return new Vector3(
      Math.sin(this.yaw) * horizontalScale,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * horizontalScale
    ).normalize();
  }

  movement(strafe: number, advance: number) {
    const movement = this.forward().scale(advance).add(this.right().scale(strafe));
    if (movement.lengthSquared() > 1) movement.normalize();
    return { x: movement.x, z: movement.z };
  }

  updateAim(player: Readonly<PlayerSnapshot> | undefined, weapon: WeaponDefinition) {
    const viewDirection = this.viewDirection();
    if (!player) {
      this.aim = viewDirection;
      return;
    }
    const muzzlePosition = new Vector3(player.x, player.y, player.z)
      .add(this.forward().scale(weapon.muzzle.forward))
      .add(this.right().scale(weapon.muzzle.side))
      .add(new Vector3(0, weapon.muzzle.height, 0));
    const pick = this.scene.pickWithRay(
      new Ray(this.camera.position, viewDirection, AIM_DISTANCE),
      (mesh) => mesh.name === "paintable-floor" ||
        mesh.name.startsWith("wall-") ||
        mesh.name.startsWith("cover-") ||
        mesh.name.startsWith("paint-surface-")
    );
    const aimPoint = pick?.hit && pick.pickedPoint
      ? pick.pickedPoint
      : this.camera.position.add(viewDirection.scale(AIM_DISTANCE));
    this.aim = aimPoint.subtract(muzzlePosition).normalize();
  }

  aimDirection() {
    return this.aim;
  }

  follow(root: TransformNode, diving: boolean) {
    const headHeight = diving ? 0.34 : PLAYER_HEAD_HEIGHT;
    const headPivot = root.position.add(new Vector3(0, headHeight, 0));
    const cameraPivot = headPivot.add(new Vector3(0, CAMERA_VERTICAL_OFFSET, 0));
    this.camera.position.copyFrom(cameraPivot.subtract(this.viewDirection().scale(CAMERA_DISTANCE)));
    this.camera.setTarget(cameraPivot);
  }
}
