export type InputControllerCallbacks = {
  onLook(deltaX: number, deltaY: number): void;
  onFireChanged(active: boolean): void;
};

export class InputController {
  private readonly keys = new Set<string>();
  private jumpQueued = false;
  private dragLookMode: boolean;
  private softLookActive = false;
  private draggingView = false;
  private dragButton = -1;
  private lastMouseX = 0;
  private lastMouseY = 0;
  private pointerLockAttempt = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly controls: HTMLDivElement,
    private readonly callbacks: InputControllerCallbacks
  ) {
    this.dragLookMode = typeof canvas.requestPointerLock !== "function";
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mouseup", this.onMouseUp);
    canvas.addEventListener("mousedown", this.onMouseDown);
    canvas.addEventListener("click", this.onClick);
    canvas.addEventListener("contextmenu", this.onContextMenu);
    document.addEventListener("pointerlockchange", this.onPointerLockChange);
    document.addEventListener("pointerlockerror", this.onPointerLockError);
    this.updateControlHint();
  }

  movementAxes() {
    return {
      strafe: Number(this.keys.has("KeyD") || this.keys.has("ArrowRight")) -
        Number(this.keys.has("KeyA") || this.keys.has("ArrowLeft")),
      advance: Number(this.keys.has("KeyW") || this.keys.has("ArrowUp")) -
        Number(this.keys.has("KeyS") || this.keys.has("ArrowDown"))
    };
  }

  consumeJump() {
    const queued = this.jumpQueued;
    this.jumpQueued = false;
    return queued;
  }

  isDiving() {
    return this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
  }

  dispose() {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mouseup", this.onMouseUp);
    this.canvas.removeEventListener("mousedown", this.onMouseDown);
    this.canvas.removeEventListener("click", this.onClick);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    document.removeEventListener("pointerlockchange", this.onPointerLockChange);
    document.removeEventListener("pointerlockerror", this.onPointerLockError);
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.code === "Escape" && (this.softLookActive || this.draggingView)) {
      this.softLookActive = false;
      this.draggingView = false;
      this.callbacks.onFireChanged(false);
      this.updateControlHint();
    }
    this.keys.add(event.code);
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(event.code)) event.preventDefault();
    if (event.code === "Space" && !event.repeat) this.jumpQueued = true;
  };

  private onKeyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.code);
  };

  private onBlur = () => {
    this.keys.clear();
    this.softLookActive = false;
    this.draggingView = false;
    this.callbacks.onFireChanged(false);
    this.updateControlHint();
  };

  private onMouseMove = (event: MouseEvent) => {
    const pointerLocked = document.pointerLockElement === this.canvas;
    if (!pointerLocked && !this.softLookActive && !this.draggingView) return;
    const deltaX = pointerLocked ? event.movementX : event.clientX - this.lastMouseX;
    const deltaY = pointerLocked ? event.movementY : event.clientY - this.lastMouseY;
    this.lastMouseX = event.clientX;
    this.lastMouseY = event.clientY;
    this.callbacks.onLook(deltaX, deltaY);
  };

  private onMouseDown = (event: MouseEvent) => {
    this.canvas.focus();
    if (event.button === 0 && (document.pointerLockElement === this.canvas || (this.dragLookMode && this.softLookActive))) {
      this.callbacks.onFireChanged(true);
      return;
    }
    if (this.dragLookMode && event.button === 2) {
      this.draggingView = true;
      this.dragButton = event.button;
      this.lastMouseX = event.clientX;
      this.lastMouseY = event.clientY;
      this.updateControlHint();
    }
  };

  private onClick = (event: MouseEvent) => {
    if (event.button !== 0) return;
    this.canvas.focus();
    this.lastMouseX = event.clientX;
    this.lastMouseY = event.clientY;
    if (this.dragLookMode) {
      if (!this.softLookActive) {
        this.softLookActive = true;
        this.updateControlHint();
      }
      return;
    }
    if (document.pointerLockElement === this.canvas) return;
    const attempt = ++this.pointerLockAttempt;
    const lockRequest = this.canvas.requestPointerLock?.();
    if (lockRequest) void lockRequest.catch((error) => this.enableDragLookFallback(error));
    window.setTimeout(() => {
      if (attempt === this.pointerLockAttempt && document.pointerLockElement !== this.canvas) {
        this.enableDragLookFallback("timeout");
      }
    }, 300);
  };

  private onMouseUp = (event: MouseEvent) => {
    if (event.button === 0) this.callbacks.onFireChanged(false);
    if (event.button !== this.dragButton || !this.draggingView) return;
    this.draggingView = false;
    this.dragButton = -1;
    this.updateControlHint();
  };

  private onContextMenu = (event: MouseEvent) => event.preventDefault();

  private onPointerLockChange = () => {
    if (document.pointerLockElement === this.canvas) {
      this.dragLookMode = false;
      this.softLookActive = false;
      this.draggingView = false;
    } else {
      this.callbacks.onFireChanged(false);
    }
    this.updateControlHint();
  };

  private onPointerLockError = (event: Event) => this.enableDragLookFallback(event);

  private enableDragLookFallback(reason?: unknown) {
    void reason;
    this.dragLookMode = true;
    this.softLookActive = true;
    this.draggingView = false;
    this.updateControlHint();
  }

  private updateControlHint() {
    const pointerLocked = document.pointerLockElement === this.canvas;
    document.body.classList.toggle("pointer-locked", pointerLocked);
    document.body.classList.toggle("drag-look", this.dragLookMode);
    document.body.classList.toggle("soft-look", this.softLookActive);
    document.body.classList.toggle("dragging-view", this.draggingView);
    document.body.classList.toggle("aim-active", pointerLocked || this.softLookActive || this.dragLookMode);
    if (this.dragLookMode) {
      this.controls.innerHTML = this.softLookActive
        ? "<b>移动鼠标</b> 转动视角 · <b>按住左键</b> 连射<br /><b>空格</b> 跳跃 · <b>Shift</b> 潜水 · <b>右键拖动</b> 备用视角"
        : "<b>点击画面</b> 启用鼠标视角<br /><b>WASD / 方向键</b> 相对镜头移动";
    } else {
      this.controls.innerHTML = pointerLocked
        ? "<b>WASD</b> 移动 · <b>按住左键</b> 连射<br /><b>空格</b> 跳跃 · <b>Shift</b> 潜水 · <b>Esc</b> 释放鼠标"
        : "<b>点击画面</b> 锁定鼠标并控制视角<br /><b>WASD / 方向键</b> 相对镜头移动";
    }
  }
}
