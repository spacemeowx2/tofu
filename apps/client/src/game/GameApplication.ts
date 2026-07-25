import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import type { GameContentDefinition } from "@tofu/simulation/content";
import { createLevelWallSurfaces } from "@tofu/simulation/level";
import { createRapierPhysicsAdapter } from "@tofu/simulation/rapier-physics";
import { GameWorld } from "@tofu/simulation/world";
import { ThirdPersonCamera } from "../camera/ThirdPersonCamera";
import { InputController } from "../input/InputController";
import { GameSession } from "../network/GameSession";
import { GameRenderer } from "../rendering/GameRenderer";
import { ColyseusRelayTransport } from "../transport";
import { HudView } from "../ui/HudView";
import { GameController } from "./GameController";
import { LocalIdentity } from "./LocalIdentity";
import { GameRuntime } from "./GameRuntime";

export class GameApplication {
  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly camera: ThirdPersonCamera;
  private readonly renderer: GameRenderer;
  private readonly hud: HudView;
  private readonly identity = new LocalIdentity();
  private world?: GameWorld;
  private input?: InputController;
  private session?: GameSession;
  private controller?: GameController;
  private currentRoomId = "";

  constructor(
    private readonly canvas: HTMLCanvasElement,
    status: HTMLDivElement,
    players: HTMLDivElement,
    feed: HTMLDivElement,
    private readonly controls: HTMLDivElement,
    private readonly content: GameContentDefinition
  ) {
    this.engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
    this.scene = new Scene(this.engine);
    this.camera = new ThirdPersonCamera(this.scene);
    this.renderer = new GameRenderer(
      this.scene,
      content.level,
      createLevelWallSurfaces(content.level)
    );
    this.hud = new HudView(status, players, feed);
  }

  async start() {
    try {
      const physics = await createRapierPhysicsAdapter(this.content.level);
      const world = new GameWorld(this.content.level, physics, this.content.weapons);
      if (world.physicsKind !== "rapier") throw new Error(`Production physics must be Rapier, got ${world.physicsKind}`);
      this.world = world;

      const endpoint = `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:2567`;
      const session = new GameSession(
        new ColyseusRelayTransport(endpoint),
        this.content.id,
        world,
        this.renderer,
        this.hud
      );
      this.session = session;

      let controller: GameController | undefined;
      const input = new InputController(this.canvas, this.controls, {
        onLook: (deltaX, deltaY) => controller?.look(deltaX, deltaY),
        onFireChanged: (active) => controller?.setFiring(active)
      });
      this.input = input;
      controller = new GameController(
        world,
        input,
        this.camera,
        this.renderer,
        session,
        this.hud,
        this.scene
      );
      this.controller = controller;
      session.setCallbacks({
        onLocalDamage: (result, attackerName, damage) =>
          controller?.handleLocalDamage(result.defeated, attackerName, damage)
      });

      const runtime = new GameRuntime({
        fixedStepSeconds: 1 / 60,
        stateSendIntervalSeconds: 1 / 20,
        maintenanceIntervalSeconds: 2,
        onFixedStep: (dt) => controller?.fixedStep(dt),
        onStateSend: () => {
          const local = world.players.get(this.identity.peerId());
          if (local && this.currentRoomId) this.identity.save(this.currentRoomId, local);
          controller?.sendState();
        },
        onMaintenance: () => controller?.reconcileInk(),
        onFrame: (dt) => controller?.frame(dt)
      });
      this.engine.runRenderLoop(() => runtime.advance(this.engine.getDeltaTime() / 1000));
      await this.connect(session, world, controller);
      window.addEventListener("resize", this.resize);
      window.addEventListener("beforeunload", this.dispose);
    } catch (error) {
      this.hud.setStatus("Rapier 初始化失败，游戏未启动");
      this.hud.addFeed(error instanceof Error ? error.message : String(error));
      this.engine.stopRenderLoop();
    }
  }

  private async connect(session: GameSession, world: GameWorld, controller: GameController) {
    const params = new URLSearchParams(location.search);
    const name = params.get("name") || `豆腐${Math.floor(100 + Math.random() * 900)}`;
    const stablePeerId = this.identity.peerId();
    try {
      const connected = await session.connect(name, stablePeerId);
      this.currentRoomId = connected.roomId;
      const teamPeers = session.peers
        .filter((peer) => peer.team === connected.team)
        .sort((a, b) => a.id.localeCompare(b.id));
      const teamSlot = Math.max(0, teamPeers.findIndex((peer) => peer.id === connected.peerId));
      const restored = this.identity.restore(
        connected.peerId,
        name,
        connected.team,
        connected.roomId
      );
      const player = restored && world.hasWeapon(restored.weaponId)
        ? world.upsertPlayer(restored)
        : world.createPlayer(
          connected.peerId,
          name,
          connected.team,
          this.content.defaultWeaponId,
          teamSlot
        );
      controller.attachLocalPlayer(player);
      this.hud.setStatus(`转发模式 · 房间 ${connected.roomId.slice(0, 6)} · ${name}`, true);
      this.hud.addFeed(`已加入 ${connected.team === 0 ? "橙队" : "青队"}；模拟由你的客户端拥有`);
    } catch (error) {
      this.hud.setStatus("无法连接转发节点");
      this.hud.addFeed(error instanceof Error ? error.message : String(error));
    }
  }

  private resize = () => this.engine.resize();

  private dispose = () => {
    this.input?.dispose();
    this.world?.dispose();
    void this.session?.close();
  };
}
