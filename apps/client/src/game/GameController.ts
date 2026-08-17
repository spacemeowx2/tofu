import type { Scene } from "@babylonjs/core/scene";
import type { PlayerSnapshot } from "@tofu/protocol";
import type { GameWorld } from "@tofu/simulation/world";
import type { ThirdPersonCamera } from "../camera/ThirdPersonCamera";
import type { InputController } from "../input/InputController";
import type { GameSession } from "../network/GameSession";
import type { GameRenderer } from "../rendering/GameRenderer";
import type { HudView } from "../ui/HudView";

export class GameController {
  private localPlayerId = "";
  private firing = false;
  private fireQueued = false;

  constructor(
    private readonly world: GameWorld,
    private readonly input: InputController,
    private readonly camera: ThirdPersonCamera,
    private readonly renderer: GameRenderer,
    private readonly session: GameSession,
    private readonly hud: HudView,
    private readonly scene: Scene
  ) {}

  attachLocalPlayer(player: Readonly<PlayerSnapshot>) {
    this.localPlayerId = player.id;
    this.session.attachLocalPlayer(player);
  }

  look(deltaX: number, deltaY: number) {
    this.camera.look(deltaX, deltaY);
    const player = this.localPlayer();
    if (player) this.camera.updateAim(player, this.world.weaponFor(player));
  }

  setFiring(active: boolean) {
    if (this.firing === active) return;
    this.firing = active;
    if (active) this.fireQueued = true;
  }

  fixedStep(dt: number) {
    const player = this.localPlayer();
    if (!player) return;

    let input;
    if (player.alive) {
      const axes = this.input.movementAxes();
      const movement = this.camera.movement(axes.strafe, axes.advance);
      let fire;
      if (this.firing || this.fireQueued) {
        this.camera.updateAim(player, this.world.weaponFor(player));
        const direction = this.camera.aimDirection();
        const forward = this.camera.forward();
        const right = this.camera.right();
        fire = {
          direction: { x: direction.x, y: direction.y, z: direction.z },
          forward: { x: forward.x, z: forward.z },
          right: { x: right.x, z: right.z }
        };
      }
      input = {
        moveX: movement.x,
        moveZ: movement.z,
        jumpPressed: this.input.consumeJump(),
        diving: this.input.isDiving(),
        fire
      };
    }

    const events = this.world.step([{ playerId: player.id, input }], dt);
    this.fireQueued = false;
    this.renderer.syncPlayer(player, true);
    this.world.bullets.forEach((bullet) => this.renderer.syncBullet(bullet));
    events.forEach((event) => this.session.publishWorldEvent(event));
    this.renderer.pruneBullets(this.world.bullets);
  }

  sendState() {
    this.session.broadcastPlayerState();
  }

  frame(dt: number) {
    this.renderer.update(dt, this.localPlayerId);
    this.renderer.followLocalPlayer(this.camera, this.localPlayerId);
    this.scene.render();
  }

  reconcileInk() {
    this.session.broadcastDirtyInkTiles();
    this.session.broadcastInkHashes();
  }

  handleLocalDamage(attackerName: string, damage: number) {
    this.hud.addFeed(`${attackerName} 命中你，造成 ${damage} 点伤害`);
  }

  private localPlayer() {
    return this.world.players.get(this.localPlayerId);
  }
}
