import type { WeaponId } from "@tofu/protocol";

export type WeaponDefinition = {
  readonly id: WeaponId;
  readonly displayName: string;
  readonly fireIntervalSeconds: number;
  readonly damage: number;
  readonly projectile: {
    readonly speed: number;
    readonly radius: number;
    readonly gravity: number;
    readonly lifetime: number;
    readonly paintRange: number;
    readonly falloffSpeedMultiplier: number;
  };
  readonly spread: {
    readonly groundDegrees: number;
    readonly airDegrees: number;
  };
  readonly muzzle: {
    readonly forward: number;
    readonly side: number;
    readonly height: number;
  };
  readonly paint: {
    readonly footEveryShots: number;
    readonly footForwardOffset: number;
    readonly trailPatterns: readonly (readonly number[])[];
    readonly splats: Readonly<Record<"impact" | "trail" | "foot", {
      readonly mainRadius: readonly [number, number];
      readonly satelliteCount: number;
      readonly forwardRange: readonly [number, number];
      readonly lateralRange: readonly [number, number];
      readonly radiusScaleRange: readonly [number, number];
    }>>;
  };
};

export const SPLATTERSHOT: WeaponDefinition = {
  id: "splattershot",
  displayName: "小绿 / 斯普拉射击枪",
  fireIntervalSeconds: 0.1,
  damage: 36,
  projectile: {
    speed: 15.5,
    radius: 0.2,
    gravity: 7.5,
    lifetime: 2.2,
    paintRange: 7.4,
    falloffSpeedMultiplier: 0.32
  },
  spread: {
    groundDegrees: 4.86,
    airDegrees: 11.66
  },
  muzzle: {
    forward: 0.72,
    side: 0.34,
    height: 0.82
  },
  paint: {
    footEveryShots: 4,
    footForwardOffset: 0.32,
    trailPatterns: [
      [0.7, 3.1],
      [1.45],
      [0.85, 4.15],
      [2.25, 5.15],
      [1.1],
      [1.8, 4.55]
    ],
    splats: {
      impact: {
        mainRadius: [0.68, 0.46],
        satelliteCount: 5,
        forwardRange: [0.32, 1.04],
        lateralRange: [0.16, 0.58],
        radiusScaleRange: [0.2, 0.52]
      },
      trail: {
        mainRadius: [0.3, 0.24],
        satelliteCount: 2,
        forwardRange: [0.32, 0.66],
        lateralRange: [0.16, 0.58],
        radiusScaleRange: [0.2, 0.52]
      },
      foot: {
        mainRadius: [0.46, 0.38],
        satelliteCount: 2,
        forwardRange: [0.16, 0.38],
        lateralRange: [0.08, 0.28],
        radiusScaleRange: [0.18, 0.42]
      }
    }
  }
};

export const SPLATTERSHOT_JR: WeaponDefinition = {
  ...SPLATTERSHOT,
  id: "splattershot-jr",
  displayName: "新叶 / 斯普拉射击枪 联名",
  fireIntervalSeconds: 0.09,
  damage: 28,
  projectile: { ...SPLATTERSHOT.projectile, paintRange: 6.6 },
  spread: { groundDegrees: 6.4, airDegrees: 13.2 },
  paint: {
    ...SPLATTERSHOT.paint,
    footEveryShots: 3,
    splats: {
      ...SPLATTERSHOT.paint.splats,
      impact: {
        ...SPLATTERSHOT.paint.splats.impact,
        mainRadius: [0.74, 0.5]
      }
    }
  }
};

export class WeaponCatalog {
  private readonly definitions: ReadonlyMap<WeaponId, WeaponDefinition>;

  constructor(definitions: readonly WeaponDefinition[]) {
    const entries = definitions.map((definition) => [definition.id, definition] as const);
    if (new Set(entries.map(([id]) => id)).size !== entries.length) throw new Error("Duplicate weapon id");
    this.definitions = new Map(entries);
  }

  get(id: WeaponId): WeaponDefinition {
    const weapon = this.definitions.get(id);
    if (!weapon) throw new Error(`Unknown weapon: ${id}`);
    return weapon;
  }

  find(id: WeaponId): WeaponDefinition | undefined {
    return this.definitions.get(id);
  }

  list(): readonly WeaponDefinition[] {
    return [...this.definitions.values()];
  }
}

export const DEFAULT_WEAPONS = new WeaponCatalog([SPLATTERSHOT, SPLATTERSHOT_JR]);
