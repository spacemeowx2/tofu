import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { ROOM_NAME } from "@tofu/protocol";
import { ArenaRoom } from "./ArenaRoom.js";

const port = Number(process.env.PORT ?? 2567);
const server = new Server({
  transport: new WebSocketTransport({
    pingInterval: 6000,
    pingMaxRetries: 4
  })
});

server.define(ROOM_NAME, ArenaRoom);
await server.listen(port);
console.log(`🥢 Tofu Arena server listening on ws://localhost:${port}`);
