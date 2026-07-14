# Tofu Arena

一个 Babylon.js 多人涂地射击 Hello World。玩家以豆腐形象进入同一张地图，移动、跳跃、潜水、连续发射抛物线墨水弹，给地面和墙面涂色并互相扣血。

默认所有权从当前版本起就是 peer-owned：每个客户端推进自己的移动和射击模拟。demo 暂时通过 Colyseus 中心节点转发带所有权的 peer 协议包；服务端不持有玩家、子弹或血量世界。后续把传输适配器替换为 WebRTC full mesh，不改玩法和消息协议。详细决策见 [ADR 0001：P2P 联机与物理引擎架构](docs/architecture/0001-p2p-networking-and-physics.md)。

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
- 按住鼠标左键沿准星方向连续发射
- `Space` 跳跃
- 按住 `Shift` 潜水；处于己方墨水地面时获得游速加成
- 接触己方墨水墙面时按住 `Shift` 附着，朝墙移动可向上游

开局地面和墙面都是中性底材，没有预涂墨水。墨水弹受重力影响，碰到可涂地面或墙面后生成队伍颜色的圆形 stamp。

## 验证

开发服务运行时执行：

```bash
pnpm check
pnpm build
pnpm smoke
```

`pnpm smoke` 会创建一个独立房间并断言：中心节点只转发 peer 包、不拥有玩法状态、拒绝伪造 owner、重连保持原 peer/team；共享模拟同时验证跳跃、己方地面潜水加速和圆角 capsule 命中。

## 当前原型边界

- `apps/client`：Babylon.js 场景、输入、peer-owned 对局与 `GameTransport` 适配器。
- `apps/server`：Colyseus roster、coordinator 和中心转发；没有 simulation tick。
- `packages/protocol`：带版本、owner、sequence 和 simulation tick 的平台无关协议。
- `packages/simulation`：不依赖 DOM、Babylon、Colyseus 或 Node 的纯 TypeScript 模拟，可运行在浏览器 peer 或公平模式服务端。
- `scripts/smoke-multiplayer.ts`：真实双客户端转发与共享模拟烟雾测试。

本地模拟固定 60Hz，owner 状态以 20Hz 发送。当前 `ColyseusRelayTransport` 只是一种 `GameTransport`；计划中的 `TrysteroTransport` 和公平模式 `ServerPeerTransport` 使用相同的 `PeerPacket`。
