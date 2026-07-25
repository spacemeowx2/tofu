import "./style.css";
import { TOFU_DEMO_CONTENT } from "@tofu/simulation/content";
import { GameApplication } from "./game/GameApplication";

const application = new GameApplication(
  document.querySelector<HTMLCanvasElement>("#game")!,
  document.querySelector<HTMLDivElement>("#status")!,
  document.querySelector<HTMLDivElement>("#players")!,
  document.querySelector<HTMLDivElement>("#feed")!,
  document.querySelector<HTMLDivElement>("#controls")!,
  TOFU_DEMO_CONTENT
);

void application.start();
