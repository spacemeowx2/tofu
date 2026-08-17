import "@babylonjs/core/Rendering/fluidRenderer/index";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { PaintStamp, TeamId } from "@tofu/protocol";
import type { WallSurface } from "@tofu/simulation/level";
import type {
  FluidRenderer,
  IFluidRenderingRenderObject
} from "@babylonjs/core/Rendering/fluidRenderer/fluidRenderer";
import type { FluidRenderingObjectCustomParticles } from "@babylonjs/core/Rendering/fluidRenderer/fluidRenderingObjectCustomParticles";

const MAX_PARTICLES = 256;
const IMPACT_ROWS = 4;
const IMPACT_LANES = [-1, -0.66, -0.33, 0, 0.33, 0.66, 1] as const;
const GRAVITY = 8.5;
const SURFACE_CLEARANCE = 0.035;
const TEAM_COLORS = [
  [0.96, 0.36, 0.12, 1],
  [0.08, 0.64, 0.68, 1]
] as const;

type InkParticle = {
  position: Vector3;
  velocity: Vector3;
  origin: Vector3;
  normal: Vector3;
  team: TeamId;
  age: number;
  lifetime: number;
};

export class InkFluidVfx {
  private readonly positions = new Float32Array(MAX_PARTICLES * 3);
  private readonly velocities = new Float32Array(MAX_PARTICLES * 3);
  private readonly colors = new Float32Array(MAX_PARTICLES * 4);
  private readonly particles: InkParticle[] = [];
  private fluid?: FluidRenderer;
  private renderObject?: IFluidRenderingRenderObject;
  private customParticles?: FluidRenderingObjectCustomParticles;

  constructor(
    private readonly scene: Scene,
    private readonly wallSurfaces: readonly WallSurface[]
  ) {}

  spawn(stamps: readonly PaintStamp[]) {
    const impacts = stamps.filter(({ kind }) => kind === "impact");
    if (impacts.length === 0 || !this.ensureRenderer()) return;
    impacts.forEach((stamp) => {
      const basis = this.surfaceBasis(stamp);
      if (!basis) return;
      const forwardScale = Math.max(0.75, Math.min(2.2, stamp.radiusU / 0.36));
      const sideScale = Math.max(0.75, Math.min(2.2, stamp.radiusV / 0.36));
      for (let row = 0; row < IMPACT_ROWS; row += 1) {
        IMPACT_LANES.forEach((lane) => {
          const laneCenter = 1 - Math.abs(lane);
          const origin = new Vector3(stamp.originX, stamp.originY, stamp.originZ);
          const position = origin
            .add(basis.normal.scale(SURFACE_CLEARANCE + row * 0.008))
            .add(basis.forward.scale(row * 0.012))
            .add(basis.side.scale(lane * 0.018));
          const velocity = basis.forward.scale((1.45 + row * 0.72 + laneCenter * 0.2) * forwardScale)
            .add(basis.side.scale(lane * (0.55 + row * 0.24) * sideScale))
            .add(basis.normal.scale(0.5 + laneCenter * 0.5 + row * 0.16));
          this.particles.push({
            position,
            velocity,
            origin,
            normal: basis.normal,
            team: stamp.team,
            age: 0,
            lifetime: 0.18 + row * 0.035 + laneCenter * 0.018 + (forwardScale - 0.75) * 0.025
          });
        });
      }
    });
    if (this.particles.length > MAX_PARTICLES) {
      this.particles.splice(0, this.particles.length - MAX_PARTICLES);
    }
    this.upload();
  }

  update(dt: number) {
    if (!this.customParticles || this.particles.length === 0) return;
    for (let index = this.particles.length - 1; index >= 0; index -= 1) {
      const particle = this.particles[index];
      particle.age += dt;
      if (particle.age >= particle.lifetime) {
        this.particles.splice(index, 1);
        continue;
      }
      particle.velocity.y -= GRAVITY * dt;
      particle.position.x += particle.velocity.x * dt;
      particle.position.y += particle.velocity.y * dt;
      particle.position.z += particle.velocity.z * dt;
      const planeDistance =
        (particle.position.x - particle.origin.x) * particle.normal.x +
        (particle.position.y - particle.origin.y) * particle.normal.y +
        (particle.position.z - particle.origin.z) * particle.normal.z;
      if (planeDistance < SURFACE_CLEARANCE) {
        const correction = SURFACE_CLEARANCE - planeDistance;
        particle.position.x += particle.normal.x * correction;
        particle.position.y += particle.normal.y * correction;
        particle.position.z += particle.normal.z * correction;
        const inwardSpeed =
          particle.velocity.x * particle.normal.x +
          particle.velocity.y * particle.normal.y +
          particle.velocity.z * particle.normal.z;
        if (inwardSpeed < 0) {
          particle.velocity.x -= particle.normal.x * inwardSpeed;
          particle.velocity.y -= particle.normal.y * inwardSpeed;
          particle.velocity.z -= particle.normal.z * inwardSpeed;
        }
        particle.velocity.scaleInPlace(0.9);
      }
    }
    if (this.particles.length === 0) {
      this.releaseRenderer();
      return;
    }
    this.upload();
  }

  dispose() {
    this.particles.length = 0;
    this.releaseRenderer();
  }

  private ensureRenderer() {
    if (this.customParticles) return true;
    const fluid = this.scene.enableFluidRenderer();
    if (!fluid) return false;
    this.fluid = fluid;
    const renderObject = fluid.addCustomParticles(
      {
        position: this.positions,
        velocity: this.velocities,
        color: this.colors
      },
      0,
      true
    );
    this.renderObject = renderObject;
    this.customParticles = renderObject.object as FluidRenderingObjectCustomParticles;
    renderObject.object.particleSize = 0.24;
    renderObject.object.particleThicknessAlpha = 0.48;
    renderObject.targetRenderer.generateDiffuseTexture = true;
    renderObject.targetRenderer.depthMapSize = 512;
    renderObject.targetRenderer.thicknessMapSize = 256;
    renderObject.targetRenderer.diffuseMapSize = 256;
    renderObject.targetRenderer.enableBlurDepth = true;
    renderObject.targetRenderer.blurDepthFilterSize = 10;
    renderObject.targetRenderer.blurDepthNumIterations = 2;
    renderObject.targetRenderer.blurDepthDepthScale = 24;
    renderObject.targetRenderer.enableBlurThickness = true;
    renderObject.targetRenderer.blurThicknessFilterSize = 6;
    renderObject.targetRenderer.blurThicknessNumIterations = 1;
    renderObject.targetRenderer.minimumThickness = 0.02;
    renderObject.targetRenderer.density = 1.45;
    renderObject.targetRenderer.refractionStrength = 0.015;
    renderObject.targetRenderer.fresnelClamp = 0.08;
    renderObject.targetRenderer.specularPower = 96;
    renderObject.targetRenderer.useVelocity = true;
    return true;
  }

  private releaseRenderer() {
    if (this.renderObject) this.fluid?.removeRenderObject(this.renderObject);
    this.renderObject = undefined;
    this.customParticles = undefined;
  }

  private surfaceBasis(stamp: PaintStamp) {
    const cos = Math.cos(stamp.rotation);
    const sin = Math.sin(stamp.rotation);
    if (stamp.surfaceId === "ground") {
      const normal = new Vector3(0, 1, 0);
      const forward = new Vector3(cos, 0, sin).normalize();
      return { normal, forward, side: Vector3.Cross(normal, forward).normalize() };
    }
    const surface = this.wallSurfaces.find((candidate) => candidate.id === stamp.surfaceId);
    if (!surface) return undefined;
    const normal = new Vector3(surface.normalX, 0, surface.normalZ);
    const forward = surface.axis === "x"
      ? new Vector3(0, sin, cos).normalize()
      : new Vector3(cos, sin, 0).normalize();
    return { normal, forward, side: Vector3.Cross(normal, forward).normalize() };
  }

  private upload() {
    if (!this.customParticles) return;
    this.particles.forEach((particle, index) => {
      const positionOffset = index * 3;
      const colorOffset = index * 4;
      this.positions[positionOffset] = particle.position.x;
      this.positions[positionOffset + 1] = particle.position.y;
      this.positions[positionOffset + 2] = particle.position.z;
      this.velocities[positionOffset] = particle.velocity.x;
      this.velocities[positionOffset + 1] = particle.velocity.y;
      this.velocities[positionOffset + 2] = particle.velocity.z;
      this.colors.set(TEAM_COLORS[particle.team], colorOffset);
    });
    this.customParticles.vertexBuffers.position.updateDirectly(this.positions, 0);
    this.customParticles.vertexBuffers.velocity.updateDirectly(this.velocities, 0);
    this.customParticles.vertexBuffers.color.updateDirectly(this.colors, 0);
    this.customParticles.setNumParticles(this.particles.length);
  }
}
