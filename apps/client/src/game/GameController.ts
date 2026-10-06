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
  private hudCountdown = 0;
  private audio?: AudioContext;

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
    this.camera.reset(player);
    this.session.attachLocalPlayer(player);
    this.renderer.followLocalPlayer(this.camera, this.localPlayerId);
  }

  look(deltaX: number, deltaY: number) {
    this.camera.look(deltaX, deltaY);
    this.renderer.followLocalPlayer(this.camera, this.localPlayerId);
    const player = this.localPlayer();
    if (player) this.camera.updateAim(player, this.world.weaponFor(player));
  }

  setFiring(active: boolean) {
    if (this.firing === active) return;
    this.firing = active;
    if (active) {
      this.audio ??= new AudioContext({ latencyHint: "interactive" });
      void this.audio.resume();
    }
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
    events.forEach((event) => {
      this.session.publishWorldEvent(event);
      if (event.kind === "shot" && event.bullet.kind === "shot") this.sound(false);
      if (event.kind === "hit" || event.kind === "target_hit") this.sound(true);
    });
    this.renderer.pruneBullets(this.world.bullets);
    this.renderer.syncTargets(this.world.targets.values());
  }

  sendState() {
    this.session.broadcastPlayerState();
  }

  frame(dt: number, alpha: number) {
    this.renderer.update(dt, this.localPlayerId, alpha);
    this.renderer.followLocalPlayer(this.camera, this.localPlayerId);
    this.hudCountdown -= dt;
    const local = this.localPlayer();
    if (local && this.hudCountdown <= 0) {
      this.hudCountdown = 0.12;
      this.hud.renderGame(local, this.world.turfCoverage(), this.world.ink.teamAt(local.x, local.z, local.y));
      this.hud.renderPlayers(this.world.players.values(), local.id);
    }
    this.scene.render();
  }

  reconcileInk() {
    this.session.broadcastDirtyInkTiles();
    this.session.broadcastInkHashes();
  }

  handleLocalDamage(attackerName: string, damage: number) {
    this.hud.addFeed(`${attackerName} 命中你，造成 ${damage} 点伤害`);
    this.hud.damage();
  }

  dispose() { void this.audio?.close(); }

  private sound(hit: boolean) {
    const audio = this.audio;
    if (!audio || audio.state !== "running") return;
    const tone = audio.createOscillator();
    const gain = audio.createGain();
    tone.type = hit ? "sine" : "triangle";
    tone.frequency.setValueAtTime(hit ? 850 : 340, audio.currentTime);
    tone.frequency.exponentialRampToValueAtTime(hit ? 1250 : 75, audio.currentTime + 0.055);
    gain.gain.setValueAtTime(hit ? 0.055 : 0.045, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.065);
    tone.connect(gain); gain.connect(audio.destination);
    tone.start(); tone.stop(audio.currentTime + 0.07);
    tone.onended = () => { tone.disconnect(); gain.disconnect(); };
  }

  private localPlayer() {
    return this.world.players.get(this.localPlayerId);
  }
}
