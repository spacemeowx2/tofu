import { PLAYER_MAX_HP, type PlayerSnapshot, type TeamId } from "@tofu/protocol";

export class HudView {
  private readonly inkFill = document.querySelector<HTMLElement>("#ink-fill")!;
  private readonly inkValue = document.querySelector<HTMLElement>("#ink-value")!;
  private readonly health = document.querySelector<HTMLElement>("#health")!;
  private readonly mode = document.querySelector<HTMLElement>("#mode")!;
  private readonly turfOrange = document.querySelector<HTMLElement>("#turf-orange")!;
  private readonly turfCyan = document.querySelector<HTMLElement>("#turf-cyan")!;
  private readonly hitFeedback = document.querySelector<HTMLElement>("#hit-feedback")!;
  private hitUntil = 0;
  private damageUntil = 0;
  constructor(
    private readonly statusElement: HTMLDivElement,
    private readonly playersElement: HTMLDivElement,
    private readonly feedElement: HTMLDivElement
  ) {}

  setStatus(message: string, online = false) {
    this.statusElement.textContent = message;
    this.statusElement.classList.toggle("online", online);
  }

  ready() {
    const button = document.querySelector<HTMLButtonElement>("#start")!;
    button.disabled = false;
    button.textContent = "进入试射场 ↗";
  }

  renderGame(player: Readonly<PlayerSnapshot>, coverage: readonly [number, number], groundTeam: TeamId | null) {
    document.documentElement.style.setProperty("--team", player.team === 0 ? "#ff632b" : "#16b5ce");
    this.inkFill.style.transform = `scaleY(${player.ink / 100})`;
    this.inkValue.textContent = `${Math.ceil(player.ink)}%`;
    this.health.textContent = `${Math.ceil(player.hp)}`;
    this.mode.textContent = !player.alive ? "正在复原…" : player.ink < 0.92 ? "墨水不足 · 潜入己方墨水补充" : player.wallAttached ? "墙面潜游" : player.diving ? groundTeam === player.team ? "潜游 · 正在补墨" : "这里没有己方墨水" : "斯普拉射击枪";
    this.turfOrange.textContent = `${coverage[0].toFixed(1)}%`;
    this.turfCyan.textContent = `${coverage[1].toFixed(1)}%`;
    document.querySelector<HTMLElement>("#turf-fill-orange")!.style.width = `${coverage[0]}%`;
    document.querySelector<HTMLElement>("#turf-fill-cyan")!.style.width = `${coverage[1]}%`;
    document.body.classList.toggle("ink-low", player.ink < 8);
    document.body.classList.toggle("diving", player.diving);
    document.body.classList.toggle("dead", !player.alive);
    document.body.classList.toggle("hit", performance.now() < this.hitUntil);
    document.body.classList.toggle("damaged", performance.now() < this.damageUntil);
    const hud = document.querySelector<HTMLElement>("#hud")!;
    hud.dataset.ink = player.ink.toFixed(2);
    hud.dataset.hp = String(player.hp);
    hud.dataset.diving = String(player.diving);
  }

  hit(damage: number, defeated: boolean) {
    this.hitFeedback.textContent = defeated ? "SPLAT!" : `${damage} HIT`;
    this.hitUntil = performance.now() + 230;
    document.body.classList.add("hit");
  }

  damage() { this.damageUntil = performance.now() + 280; document.body.classList.add("damaged"); }

  renderPlayers(players: Iterable<Readonly<PlayerSnapshot>>, localPlayerId: string) {
    this.playersElement.innerHTML = [...players].map((player) => {
      const hpColor = player.hp > 50 ? "#43ad61" : player.hp > 0 ? "#e5a83c" : "#bd4034";
      const team = player.team === 0 ? "橙" : "青";
      return `<div class="player-card"><i style="background:${player.team === 0 ? "#ff632b" : "#16b5ce"}"></i><div class="player-line"><strong>${escapeHtml(player.name)}${player.id === localPlayerId ? " · 你" : ""}</strong><span>${Math.ceil(player.hp)}/${PLAYER_MAX_HP}</span></div><div class="hp-track"><div class="hp-fill" style="width:${player.hp}%;background:${hpColor}"></div></div></div>`;
    }).join("");
  }

  addFeed(message: string) {
    const item = document.createElement("div");
    item.className = "feed-item";
    item.textContent = message;
    this.feedElement.prepend(item);
    while (this.feedElement.children.length > 4) this.feedElement.lastElementChild?.remove();
    window.setTimeout(() => item.remove(), 4500);
  }
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>'"]/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!
  );
}
