import { PLAYER_MAX_HP, type PlayerSnapshot } from "@tofu/protocol";

export class HudView {
  constructor(
    private readonly statusElement: HTMLDivElement,
    private readonly playersElement: HTMLDivElement,
    private readonly feedElement: HTMLDivElement
  ) {}

  setStatus(message: string, online = false) {
    this.statusElement.textContent = message;
    this.statusElement.classList.toggle("online", online);
  }

  renderPlayers(players: Iterable<Readonly<PlayerSnapshot>>, localPlayerId: string) {
    this.playersElement.innerHTML = [...players].map((player) => {
      const hpColor = player.hp > 50 ? "#43ad61" : player.hp > 0 ? "#e5a83c" : "#bd4034";
      const team = player.team === 0 ? "橙" : "青";
      return `<div class="player-card"><div class="player-line"><strong>${team} · ${escapeHtml(player.name)}${player.id === localPlayerId ? " · 你" : ""}</strong><span>${player.hp}/${PLAYER_MAX_HP}</span></div><div class="hp-track"><div class="hp-fill" style="width:${player.hp}%;background:${hpColor}"></div></div></div>`;
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
