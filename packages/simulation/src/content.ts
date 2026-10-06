import type { WeaponId } from "@tofu/protocol";
import { TOFU_ARENA_LEVEL, type LevelDefinition } from "./level.js";
import { DEFAULT_WEAPONS, SPLATTERSHOT, type WeaponCatalog } from "./weapons.js";

export type GameContentDefinition = {
  readonly id: string;
  readonly level: LevelDefinition;
  readonly weapons: WeaponCatalog;
  readonly defaultWeaponId: WeaponId;
};

export const TOFU_DEMO_CONTENT: GameContentDefinition = {
  id: "tofu-yard-v2",
  level: TOFU_ARENA_LEVEL,
  weapons: DEFAULT_WEAPONS,
  defaultWeaponId: SPLATTERSHOT.id
};
