import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Ray } from "@babylonjs/core/Culling/ray";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { PlayerSnapshot } from "@tofu/protocol";
import type { WeaponDefinition } from "@tofu/simulation/weapons";

const CAMERA_SENSITIVITY = 0.0024;
const CAMERA_DISTANCE = 5.5;
const PLAYER_HEAD_HEIGHT = 1.04;
const AIM_DISTANCE = 45;

export class ThirdPersonCamera {
  readonly camera: FreeCamera;
  private yaw = 0;
  private pitch = -0.20;
  private aim = new Vector3(0, 0, 1);

  constructor(private readonly scene: Scene) {
    this.camera = new FreeCamera("camera", new Vector3(0, 2.85, -5.5), scene);
    this.camera.minZ = 0.1;
    this.camera.maxZ = 150;
    this.camera.fov = 0.95;
    this.camera.inputs.clear();
  }

  look(deltaX: number, deltaY: number) {
    this.yaw += deltaX * CAMERA_SENSITIVITY;
    this.pitch = Math.max(-1.05, Math.min(0.65, this.pitch - deltaY * CAMERA_SENSITIVITY));
  }

  reset(player: Readonly<PlayerSnapshot>) {
    this.yaw = Math.atan2(player.facingX, player.facingZ);
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
    const viewDirection = this.camera.getForwardRay().direction;
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
      (mesh) => mesh.name.startsWith("paintable-") || mesh.name.startsWith("target-body-") ||
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

  follow(root: TransformNode) {
    const pivot = root.position.add(new Vector3(0, PLAYER_HEAD_HEIGHT, 0));
    const backward = this.viewDirection().scale(-1);
    const hit = this.scene.pickWithRay(new Ray(pivot, backward, CAMERA_DISTANCE),
      (mesh) => mesh.name.startsWith("paintable-") || mesh.name.startsWith("wall-") || mesh.name.startsWith("cover-") || mesh.name.startsWith("paint-surface-"));
    const distance = hit?.hit ? Math.max(0.1, hit.distance - 0.22) : CAMERA_DISTANCE;
    this.camera.position.copyFrom(pivot.add(backward.scale(distance)));
    this.camera.setTarget(pivot.add(new Vector3(0, 0.42 * distance / CAMERA_DISTANCE, 0)));
  }
}
