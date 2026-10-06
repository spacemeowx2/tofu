import assert from "node:assert/strict";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { ThirdPersonCamera } from "../src/camera/ThirdPersonCamera.js";
import { createPlayerState } from "../../../packages/simulation/src/systems.js";
import { COMPACT_TEST_LEVEL } from "@tofu/simulation/level";
import { SPLATTERSHOT } from "@tofu/simulation/weapons";

const engine = new NullEngine();
const scene = new Scene(engine);
try {
  const camera = new ThirdPersonCamera(scene);
  const root = new TransformNode("player", scene);
  const player = { ...createPlayerState("camera", "Camera", 0, SPLATTERSHOT.id, 0, COMPACT_TEST_LEVEL), x: 0, z: 0, facingX: 0, facingZ: 1 };
  camera.reset(player);
  const wall = MeshBuilder.CreateBox("cover-near-camera", { width: 3, height: 3, depth: 0.1 }, scene);
  wall.position.set(0, 1.5, -0.55);
  wall.computeWorldMatrix(true);
  camera.follow(root);
  assert.ok(camera.camera.position.z > -0.5, "minimum camera distance pushed the camera through a nearby wall");
  wall.dispose();
  camera.follow(root);
  const pivot = new Vector3(0, 1.04, 0);
  const distance = Vector3.Distance(camera.camera.position, pivot);
  camera.updateAim(player, SPLATTERSHOT);
  const beforePitch = camera.aimDirection().y;
  camera.look(0, -80);
  camera.follow(root);
  camera.updateAim(player, SPLATTERSHOT);
  assert.ok(camera.aimDirection().y > beforePitch, "moving the mouse upward aimed downward");
  assert.ok(Math.abs(Vector3.Distance(camera.camera.position, pivot) - distance) < 1e-6, "vertical orbit moved the head pivot");
  camera.look(Math.PI / 2 / 0.0024, 0);
  const movement = camera.movement(0, 1);
  assert.ok(movement.x > 0.99 && Math.abs(movement.z) < 1e-6, "W did not follow the camera heading");
  console.log(JSON.stringify({ ok: true, cameraWallCollision: true, fixedHeadPivot: true, mousePitch: true, cameraRelativeMovement: true }));
} finally {
  scene.dispose(); engine.dispose();
}
