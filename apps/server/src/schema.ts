import { MapSchema, Schema, type } from "@colyseus/schema";
import { PLAYER_MAX_HP } from "@tofu/protocol";

export class PlayerState extends Schema {
  @type("string") id = "";
  @type("string") name = "Tofu";
  @type("number") x = 0;
  @type("number") z = 0;
  @type("number") facingX = 0;
  @type("number") facingZ = 1;
  @type("number") hp = PLAYER_MAX_HP;
  @type("boolean") alive = true;
}

export class BulletState extends Schema {
  @type("string") id = "";
  @type("string") ownerId = "";
  @type("number") x = 0;
  @type("number") y = 0.85;
  @type("number") z = 0;
  @type("number") dx = 0;
  @type("number") dy = 0;
  @type("number") dz = 1;
  @type("number") age = 0;
}

export class ArenaState extends Schema {
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type({ map: BulletState }) bullets = new MapSchema<BulletState>();
  @type("number") tick = 0;
}
