import { MapSchema, Schema, type } from "@colyseus/schema";

export class PeerState extends Schema {
  @type("string") id = "";
  @type("string") name = "Tofu";
  @type("uint8") team = 0;
}

export class LobbyState extends Schema {
  @type({ map: PeerState }) peers = new MapSchema<PeerState>();
  @type("string") coordinatorId = "";
  @type("string") authorityMode = "peer";
  @type("uint32") epoch = 1;
}
