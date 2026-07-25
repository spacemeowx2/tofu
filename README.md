# Tofu Arena

一个 Babylon.js 多人涂地射击 Hello World。玩家以豆腐形象进入同一张地图，移动、跳跃、潜水、连续发射抛物线墨水弹，给地面和墙面涂色并互相扣血。

默认所有权从当前版本起就是 peer-owned：每个客户端推进自己的移动和射击模拟。demo 暂时通过 Colyseus 中心节点转发带所有权的 peer 协议包；服务端不持有玩家、子弹或血量世界。后续把传输适配器替换为 WebRTC full mesh，不改玩法和消息协议。详细决策见 [ADR 0001：P2P 联机与物理引擎架构](docs/architecture/0001-p2p-networking-and-physics.md)。

玩法运行时已经拆成固定 tick `GameWorld`、输入、摄像机、网络会话和 Babylon 渲染边界；关卡/武器为数据定义，墨水使用可校验的 ownership tile，碰撞默认由 Rapier WASM shape cast 提供。模块职责和扩展方式见 [ADR 0002：可扩展游戏运行时边界](docs/architecture/0002-game-runtime-boundaries.md)。

## 运行

```bash
pnpm install
pnpm dev
```

然后打开 [http://localhost:15173](http://localhost:15173)。测试两名玩家时可以打开两个标签页：

- `http://localhost:15173/?name=Alpha`
- `http://localhost:15173/?name=Bravo`

操作方式：

- Chrome / Firefox 等支持 Pointer Lock 的浏览器：点击画面锁定鼠标，按 `Esc` 释放
- Pointer Lock 被禁用或拒绝时：点击画面启用软视角，移动鼠标即可旋转，`Esc` 暂停；也可以按住鼠标拖动
- `WASD` 或方向键相对摄像机方向移动
- 鼠标移动控制第三人称视角
- 按住鼠标左键沿准星方向连续发射
- `Space` 跳跃
- 按住 `Shift` 潜水；处于己方墨水地面时获得游速加成
- 接触己方墨水墙面时按住 `Shift` 附着，朝墙移动可向上游

开局地面和墙面都是中性底材，没有预涂墨水。当前武器是“小绿”斯普拉射击枪：每秒 10 发、单发 36 伤害，弹道带确定性的扇形散布与分段落墨；碰到可涂地面或墙面后生成一个主墨斑和若干卫星墨点组成的不规则墨迹。

## 验证

开发服务运行时执行：

```bash
pnpm check
pnpm build
pnpm test:architecture
pnpm smoke
```

`pnpm test:architecture` 验证固定 tick、数据驱动定义、世界 snapshot/restore、墨水 tile/hash 和 Rapier shape cast。`pnpm smoke` 会创建一个独立房间并断言：中心节点只转发 peer 包、不拥有玩法状态、拒绝伪造 owner、重连保持原 peer/team；共享模拟同时验证跳跃、己方地面潜水加速、圆角 capsule 命中，以及小绿的连射速度、扇形散布、弹道落墨和不规则墨斑。

## 当前原型边界

- `apps/client`：生命周期装配，以及独立的输入、摄像机、网络会话和 Babylon 渲染模块。
- `apps/server`：Colyseus roster、coordinator 和中心转发；不推进 simulation tick。
- `packages/protocol`：带版本、owner、sequence 和 simulation tick 的平台无关协议。
- `packages/simulation`：平台无关的 `GameWorld`、关卡/武器定义、墨水 ownership tile、Rapier/解析物理适配器，可运行在浏览器 peer 或公平模式服务端。
- `scripts/smoke-architecture.ts`：纯本地架构边界和 snapshot/hash/Rapier 回归测试。
- `scripts/smoke-multiplayer.ts`：真实双客户端转发与共享模拟烟雾测试。

本地模拟固定 60Hz，owner 状态以 20Hz 发送。当前 `ColyseusRelayTransport` 只是一种 `GameTransport`；计划中的 `TrysteroTransport` 和公平模式 `ServerPeerTransport` 使用相同的 `PeerPacket`。
