import type { Scene } from "@babylonjs/core/scene";
import type { PlayerSnapshot } from "@tofu/protocol";
import type { GameWorld } from "@tofu/simulation/world";
import type { ThirdPersonCamera } from "../camera/ThirdPersonCamera";
import type { InputController } from "../input/InputController";
import type { GameSession } from "../network/GameSession";
import type { GameRenderer } from "../rendering/GameRenderer";
import type { HudView } from "../ui/HudView";

const RESPAWN_SECONDS = 2.5;

export class GameController {
  private localPlayerId = "";
  private bulletSequence = 0;
  private respawnRemaining = 0;
  private firing = false;
  private fireAccumulator = 0;

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
    this.fireAccumulator = 0;
    if (active) this.shoot();
  }

  fixedStep(dt: number) {
    const player = this.localPlayer();
    if (!player) return;
    if (!player.alive) {
      this.respawnRemaining -= dt;
      if (this.respawnRemaining <= 0) {
        const respawned = this.world.respawnPlayer(player.id, 0);
        if (respawned) {
          this.hud.addFeed("你已重新凝固");
          this.session.broadcastPlayerState();
        }
      }
    }

    let input;
    if (player.alive) {
      const axes = this.input.movementAxes();
      const movement = this.camera.movement(axes.strafe, axes.advance);
      const wallContact = this.world.wallContactFor(player.id);
      const wallTeam = wallContact
        ? this.world.ink.teamAtWall(wallContact.id, wallContact.x, wallContact.y, wallContact.z)
        : null;
      input = {
        moveX: movement.x,
        moveZ: movement.z,
        jumpPressed: this.input.consumeJump(),
        diving: this.input.isDiving(),
        groundTeam: this.world.ink.teamAt(player.x, player.z),
        wallContact: wallContact ? { ...wallContact, team: wallTeam } : undefined
      };
    }

    const events = this.world.step(player.id, input, dt);
    this.renderer.syncPlayer(player, true);
    this.world.bullets.forEach((bullet) => this.renderer.syncBullet(bullet));
    events.forEach((event) => this.session.publishWorldEvent(event));
    this.renderer.pruneBullets(this.world.bullets);
  }

  sendState() {
    this.session.broadcastPlayerState();
  }

  frame(dt: number) {
    this.updateContinuousFire(dt);
    this.renderer.update(dt, this.localPlayerId);
    this.renderer.followLocalPlayer(this.camera, this.localPlayerId);
    this.scene.render();
  }

  reconcileInk() {
    this.session.broadcastDirtyInkTiles();
    this.session.broadcastInkHashes();
  }

  handleLocalDamage(defeated: boolean, attackerName: string, damage: number) {
    this.hud.addFeed(`${attackerName} 命中你，造成 ${damage} 点伤害`);
    if (defeated) this.respawnRemaining = RESPAWN_SECONDS;
  }

  private updateContinuousFire(dt: number) {
    if (!this.firing) return;
    const player = this.localPlayer();
    if (!player) return;
    this.fireAccumulator += dt;
    const interval = this.world.weaponFor(player).fireIntervalSeconds;
    while (this.fireAccumulator >= interval) {
      this.fireAccumulator -= interval;
      this.shoot();
    }
  }

  private shoot() {
    const player = this.localPlayer();
    if (!player?.alive || player.diving) return;
    this.camera.updateAim(player, this.world.weaponFor(player));
    const forward = this.camera.forward();
    const right = this.camera.right();
    const aim = this.camera.aimDirection();
    const shotIndex = ++this.bulletSequence;
    const result = this.world.shoot(
      player.id,
      `${player.id}:${shotIndex}`,
      { x: aim.x, y: aim.y, z: aim.z },
      { x: forward.x, z: forward.z },
      { x: right.x, z: right.z },
      shotIndex
    );
    if (!result) return;
    this.session.sendShot(result.bullet);
    result.events.forEach((event) => this.session.publishWorldEvent(event));
  }

  private localPlayer() {
    return this.world.players.get(this.localPlayerId);
  }
}
