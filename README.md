# Tofu Arena

一个 Babylon.js + Colyseus 的多人射击 Hello World。玩家以豆腐形象进入同一张地图，移动、发射豆子弹，并由服务器判定命中和扣血。

当前实现是用于验证操作和战斗闭环的权威服务器原型。目标架构将迁移为 WebRTC P2P、Rapier 碰撞和独立墨水归属系统，详细决策及验证门槛见 [ADR 0001：P2P 联机与物理引擎架构](docs/architecture/0001-p2p-networking-and-physics.md)。

## 运行

```bash
pnpm install
pnpm dev
```

然后打开 [http://localhost:5173](http://localhost:5173)。测试两名玩家时可以打开两个标签页：

- `http://localhost:5173/?name=Alpha`
- `http://localhost:5173/?name=Bravo`

操作方式：

- Chrome / Firefox 等支持 Pointer Lock 的浏览器：点击画面锁定鼠标，按 `Esc` 释放
- Pointer Lock 被禁用或拒绝时：点击画面启用软视角，移动鼠标即可旋转，`Esc` 暂停；也可以按住鼠标拖动
- `WASD` 或方向键相对摄像机方向移动
- 鼠标移动控制第三人称视角
- 鼠标左键或空格沿准星方向发射

## 验证

开发服务运行时执行：

```bash
pnpm check
pnpm build
pnpm smoke
```

`pnpm smoke` 会创建一个独立房间，让两个程序化客户端靠近并射击，断言目标生命值从 100 降到 75。

## 当前原型边界

- `apps/client`：Babylon.js 场景、豆腐渲染、输入、HUD。
- `apps/server`：Colyseus 权威房间、移动、子弹、碰撞、扣血和复活。
- `packages/protocol`：客户端和服务器共享的消息、常量与地图障碍数据。
- `scripts/smoke-multiplayer.ts`：真实 WebSocket 双客户端烟雾测试。

客户端不直接修改位置或血量。服务器以 30Hz 推进模拟并以 20Hz 同步状态。这一实现用于 smoke test 和迁移前对照，不代表最终联机所有权；P2P 迁移将在 ADR 定义的技术 spike 通过后开始。
