export type GameRuntimeOptions = {
  fixedStepSeconds: number;
  stateSendIntervalSeconds: number;
  maintenanceIntervalSeconds: number;
  onFixedStep(dt: number): void;
  onStateSend(): void;
  onFrame(dt: number): void;
  onMaintenance(): void;
};

export class GameRuntime {
  private simulationAccumulator = 0;
  private stateSendAccumulator = 0;
  private maintenanceAccumulator = 0;

  constructor(private readonly options: GameRuntimeOptions) {}

  advance(rawDeltaSeconds: number) {
    const dt = Math.min(rawDeltaSeconds, 0.1);
    this.simulationAccumulator += dt;
    while (this.simulationAccumulator >= this.options.fixedStepSeconds) {
      this.simulationAccumulator -= this.options.fixedStepSeconds;
      this.options.onFixedStep(this.options.fixedStepSeconds);
    }
    this.stateSendAccumulator += dt;
    if (this.stateSendAccumulator >= this.options.stateSendIntervalSeconds) {
      this.stateSendAccumulator %= this.options.stateSendIntervalSeconds;
      this.options.onStateSend();
    }
    this.maintenanceAccumulator += dt;
    if (this.maintenanceAccumulator >= this.options.maintenanceIntervalSeconds) {
      this.maintenanceAccumulator %= this.options.maintenanceIntervalSeconds;
      this.options.onMaintenance();
    }
    this.options.onFrame(dt);
  }
}
