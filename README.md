# Tofu Arena

一个 Babylon.js 多人涂地射击原型。当前版本是屋顶试射场：圆角豆腐角色、右手寿司枪、平台与掩体、四个可击倒的训练靶。可以连续射击、涂地、跳上平台、潜入己方墨水补墨，或沿涂好的墙面爬上墙顶。

默认所有权从当前版本起就是 peer-owned：每个客户端推进自己的移动和射击模拟。demo 暂时通过 Colyseus 中心节点转发带所有权的 peer 协议包；服务端不持有玩家、子弹或血量世界。后续把传输适配器替换为 WebRTC full mesh，不改玩法和消息协议。详细决策见 [ADR 0001：P2P 联机与物理引擎架构](docs/architecture/0001-p2p-networking-and-physics.md)。

玩法运行时已经拆成固定 tick `GameWorld`、应用装配、控制器、输入、摄像机、网络会话、HUD 和 Babylon 渲染边界；射速、子弹序号、死亡/复活计时与出生槽位都随世界快照迁移。关卡/武器通过 `GameContentDefinition` 注入，墨水使用可校验并可局部同步的 ownership tile，生产循环只允许 Rapier WASM shape cast。模块职责和扩展方式见 [ADR 0002：可扩展游戏运行时边界](docs/architecture/0002-game-runtime-boundaries.md)。

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

开局地面、墙面和墙顶都是中性底材，没有预涂墨水。当前武器是“小绿”斯普拉射击枪：每秒 10 发、单发 36 伤害，弹道带确定性的扇形散布，沿途墨滴实际碰撞后落墨。主弹墨斑按入射角沿射击方向逐步伸展；永久墨面由可同步的 ownership mask 驱动，着弹瞬间另用短寿命流体粒子表现黏稠体积。Rapier 负责三维移动和环境碰撞，FluidRenderer 负责体积表现。

### 屋顶试射场重做（2026-10-06）

- 点击「进入试射场」锁定鼠标；镜头围绕头部转动，并避开掩体。移动按 60Hz 模拟、按渲染帧插值。
- 主弹沿准星射出，沿途掉落的墨滴也有独立弹道，实际碰撞后才涂色。主弹着地后，墨斑在 180ms 内逐步向入射方向铺开；扩散过程属于共享模拟并进入 snapshot/restore。
- 地面、墙面和平台顶面分别保存 ownership tile。湿润墨膜有平滑边缘、微小几何厚度和起伏高光，着弹时有短寿命体积喷溅。这里使用可同步的定向铺墨模型，没有做完整液体求解。
- 每发消耗 0.92% 墨水；停止开火 20 帧后可以补墨。己方墨水中潜游约 3.33 秒补满，站立补充较慢；敌墨和干地潜行会减速。生命值停止受伤后恢复。
- 训练靶三发击倒，显示累计伤害并在两秒后复原。训练靶供各玩家独立试射；真实玩家的命中、死亡和复活继续走 peer 协议。
- HUD 显示双方涂地面积、生命、墨水槽和当前潜游状态。射击有枪口喷溅、后坐力和合成音效。
- 联机节点暂时不可用时，可以继续单人训练。多人仍然是客户端拥有模拟，中心节点只转发。

武器数值参考 [Inkipedia 的 Splattershot 数据](https://splatoonwiki.org/wiki/Splattershot)，涂地/潜游体验参考 [Nintendo 的 Splatoon 3 介绍](https://splatoon.nintendo.com/en/world/)。地图、角色和材质均在本项目中生成。

保持开发服务运行：

```bash
tmux new-session -d -s tofu-dev -c /Users/space/project/tofu 'pnpm dev'
tmux attach -t tofu-dev
```

## 验证

开发服务运行时执行：

```bash
pnpm check
pnpm build
pnpm test:architecture
pnpm test:gameplay
pnpm smoke
```

`pnpm test:architecture` 验证固定 tick、第二武器/第二关卡、Rapier 世界 snapshot/restore 后连射节奏和复活倒计时连续、墨水 tile/hash、Lamport revision、同 revision 冲突收敛和旧 tile 合并。`pnpm test:gameplay` 验证平台落地与跳跃、墙顶独立涂色、弹药/补墨、扩散中的快照恢复、真实落墨、训练靶、高速弹丸扫掠命中，以及镜头碰撞、头部转轴、鼠标俯仰和相机相对移动。`pnpm smoke` 会创建一个独立房间并断言：中心节点只转发 peer 包、不拥有玩法状态、拒绝伪造 owner、重连保持原 peer/team；共享模拟同时验证多 authority 单 tick、跳跃、由世界判定的己方墨水潜水加速/爬墙、圆角 capsule 命中，以及小绿的扇形散布、瞄准俯仰和弹道落墨。

## 当前原型边界

- `apps/client`：薄入口、生命周期装配、控制器，以及独立的输入、摄像机、网络会话、HUD 和 Babylon 渲染模块。
- `apps/server`：Colyseus roster、coordinator 和中心转发；不推进 simulation tick。
- `packages/protocol`：带版本、owner、sequence、simulation tick 和独立墨水 revision 的平台无关协议。
- `packages/simulation`：平台无关的 `GameWorld`、内容/关卡/武器定义、墨水 ownership tile、生产 Rapier 与显式测试解析适配器，可运行在浏览器 peer 或公平模式服务端。
- `scripts/smoke-architecture.ts`：纯本地架构边界和 snapshot/hash/Rapier 回归测试。
- `scripts/smoke-multiplayer.ts`：真实双客户端转发与共享模拟烟雾测试。

本地模拟固定 60Hz，owner 状态以 20Hz 发送。当前 `ColyseusRelayTransport` 只是一种 `GameTransport`；计划中的 `TrysteroTransport` 和公平模式 `ServerPeerTransport` 使用相同的 `PeerPacket`。
