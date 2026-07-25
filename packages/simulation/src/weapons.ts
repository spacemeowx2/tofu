import type { WeaponId } from "@tofu/protocol";

export type WeaponDefinition = {
  id: WeaponId;
  displayName: string;
  fireIntervalSeconds: number;
  damage: number;
  projectile: {
    speed: number;
    radius: number;
    gravity: number;
    lifetime: number;
    paintRange: number;
    falloffSpeedMultiplier: number;
  };
  spread: {
    groundDegrees: number;
    airDegrees: number;
  };
  muzzle: {
    forward: number;
    side: number;
    height: number;
  };
  paint: {
    footEveryShots: number;
    trailPatterns: readonly (readonly number[])[];
    impactMainRadius: readonly [number, number];
    trailMainRadius: readonly [number, number];
    footMainRadius: readonly [number, number];
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
    trailPatterns: [
      [0.7, 3.1],
      [1.45],
      [0.85, 4.15],
      [2.25, 5.15],
      [1.1],
      [1.8, 4.55]
    ],
    impactMainRadius: [0.68, 0.46],
    trailMainRadius: [0.3, 0.24],
    footMainRadius: [0.46, 0.38]
  }
};

const WEAPONS = new Map<WeaponId, WeaponDefinition>([[SPLATTERSHOT.id, SPLATTERSHOT]]);

export function getWeaponDefinition(id: WeaponId): WeaponDefinition {
  const weapon = findWeaponDefinition(id);
  if (!weapon) throw new Error(`Unknown weapon: ${id}`);
  return weapon;
}

export function findWeaponDefinition(id: WeaponId): WeaponDefinition | undefined {
  return WEAPONS.get(id);
}

export function listWeaponDefinitions(): readonly WeaponDefinition[] {
  return [...WEAPONS.values()];
}
