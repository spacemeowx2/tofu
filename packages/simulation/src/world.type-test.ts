import type { GameWorld } from "./world.js";

declare const world: GameWorld;

// These compile-time assertions are the public ownership boundary: callers may
// observe world state but must use GameWorld commands to mutate it.
// @ts-expect-error tick is exposed as a getter only
world.tick = 42;
// @ts-expect-error player collection is readonly
world.players.set("outside", {} as never);
// @ts-expect-error bullet collection is readonly
world.bullets.clear();
// @ts-expect-error ink mutation is not part of the public view
world.ink.paint({} as never);
