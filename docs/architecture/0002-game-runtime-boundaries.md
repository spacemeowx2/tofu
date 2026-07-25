# ADR 0002: 可扩展游戏运行时边界

- 状态：采用并已落地
- 日期：2026-07-26
- 范围：客户端组织、共享模拟、关卡/武器数据、墨水同步、物理适配器

## 背景

Hello World 最初把输入、摄像机、固定步长、网络包、场景构造、角色/子弹视图和玩法循环放在同一个客户端入口中。它适合快速验证，但继续增加武器、地图、模式、回放或公平服务端会造成玩法规则与浏览器实现互相依赖。

这次改造的目标不是建立一个抽象框架，而是明确五个可验证边界：

1. 客户端入口只负责装配生命周期。
2. 共享 `GameWorld` 是玩法状态和固定 tick 的唯一拥有者。
3. 武器与关卡由数据定义驱动。
4. 墨水归属是规则数据，GPU 纹理只是消费者。
5. 碰撞通过平台无关的 `PhysicsAdapter` 进入模拟，默认实现为 Rapier WASM。

## 决策

### 客户端层

| 模块 | 职责 | 不负责 |
| --- | --- | --- |
| `GameRuntime` | render delta、60 Hz fixed step、20 Hz 状态发送调度 | 玩法规则、DOM 输入 |
| `InputController` | 键盘、Pointer Lock、软视角、跳跃/潜水/射击意图 | 修改玩家坐标 |
| `ThirdPersonCamera` | yaw/pitch、相机相对移动方向、准星 ray pick、跟随 | 发射子弹 |
| `PeerSession` | 给 transport 包补 owner、sequence、simulation tick | Colyseus/WebRTC 细节、玩法校验 |
| `GameSession` | roster、协议校验、远端命令路由、墨水 hash/tile 协商 | 直接改 Map、推进 fixed tick |
| `GameRenderer` | Babylon 场景、关卡 mesh、角色/子弹插值、墨水纹理 | 决定命中、地面归属或移动 |
| `GameController` | 把输入/相机意图交给世界，把世界事件交给 session/renderer | 保存第二份玩法世界 |
| `GameApplication` | Rapier 初始化、内容注入、生命周期装配 | 玩法规则、网络包分发 |
| `main.ts` | 选择 `GameContentDefinition` 并启动应用 | bootstrap、玩法、HUD、存储 |

`GameTransport` 仍是网络端口；`PeerSession` 是连接玩法入口与该端口的会话层。替换成 WebRTC adapter 时，输入、世界和渲染模块不变。

### 共享模拟层

`GameWorld` 拥有：

- 当前 tick；
- `players` 与 `bullets`；
- `TiledInkField`；
- 当前 `LevelDefinition`；
- 构造时注入、之后不可替换的 `PhysicsAdapter`；
- `shoot()` 和 `step()` 产生的 paint、hit、bullet-removed 事件；
- `snapshot()` / `restore()`，供重连、回放、host migration 和 server peer 接管。

浏览器和未来 server peer 都调用同一个 `GameWorld.step()`。客户端不再分别推进玩家和子弹，也不直接进行墙体碰撞查询。

### 数据定义

`LevelDefinition` 包含稳定地图 ID、边界、墙高、障碍物和双方出生点。渲染 mesh、解析碰撞器、Rapier collider、墙面 `surfaceId` 与墨水 grid 都从同一份定义生成。

`WeaponDefinition` 包含射速、伤害、弹速、半径、重力、寿命、射程衰减、散布、枪口位置，以及三种墨斑的主半径、卫星数、偏移和缩放范围。`WeaponCatalog` 随 `GameContentDefinition` 注入世界，`PlayerSnapshot` 明确携带 `weaponId`。协议中的 `WeaponId` 是开放字符串，因此增加武器不要求修改协议 union。仓库同时注册了 `splattershot` 与 `splattershot-jr`，架构测试会用第二武器和不同尺寸的第二关卡创建完整世界，防止定义只停留在类型层。

### 墨水归属与同步

`TiledInkField` 为地面和每个墙面保存：

- `owners: Uint8Array`：`0/1` 为队伍，`255` 为中性；
- `ticks: Uint32Array`：每格最后更新时间；
- `writers: Uint32Array`：同 tick 冲突的稳定 writer，保证双方按相同顺序收敛；
- dirty tile 集合；
- 每 tile FNV-1a hash；
- 全量世界快照、dirty tile 快照和校验后合并。

收到 tile 时会验证维度、边界、owner 值、tick、writer、数组长度和 hash。较旧 tick 不能覆盖较新格子；同 tick 由稳定 writer 决胜。没有改变任何格子的相同/陈旧 tile 不会重新标 dirty，避免 peer 之间持续回声。`GameWorld.applyPaint()` 返回裁决后的局部权威 tile，GPU 只消费这些 tile；原始 stamp 只用于协议和规则输入，不能绕过 ownership 写纹理。`InkTextureRenderer` 负责把权威 tile 投影到 DynamicTexture；潜水和爬墙只查询 `TiledInkField`，不读取像素颜色。

运行时每两秒发送 dirty tile，并交换分块 tile hash；接收端只向具体 peer 请求 hash 不同的 tile。hash、请求和 8×8 tile 都受单包数量上限约束，避免 relay/WebRTC DataChannel payload 突增。新 peer 与恢复连接使用同一套局部快照协议，不再发送完整世界墨水。

### 物理

`PhysicsAdapter` 暴露三类规则所需查询：

- capsule 期望位移修正；
- 可附着墙面探测；
- 高速墨水弹 shape cast。

`RapierPhysicsAdapter` 从 `LevelDefinition` 创建静态 cuboid collider，使用 capsule/ball shape cast，且不创建动态子弹刚体。生产应用必须先完成 Rapier 初始化才会构造 `GameWorld` 和启动循环；失败时停在错误状态，不允许静默切到另一种物理。`AnalyticPhysicsAdapter` 只保留为显式测试工具。完整快照携带 `physicsKind`，实时 packet header 携带并校验 `contentId`、`levelId` 和 `physicsKind`；恢复或实时联机都会拒绝不兼容世界，peer 不会在不知情时混用 adapter/关卡/内容。

## 状态流

```text
InputController ─┐
ThirdPersonCamera ├─> GameController ─> GameWorld.step/shoot ─> GameWorldEvent ─> GameSession ─> PeerSession ─> GameTransport
                 │             │                    │
                 │             └─ TiledInkField     └─> GameRenderer
                 └──────── movement/aim                  │
                                                        └─ Babylon/GPU
```

远端数据按相反方向进入：`GameTransport -> PeerSession -> GameSession -> GameWorld -> GameRenderer`。渲染对象不反向写回模拟。

## 验证

`pnpm test:architecture` 会断言：

- render delta 被转换为稳定 fixed tick；
- 第二武器和不同尺寸第二关卡确实驱动出生点、UV 和完整世界；
- 中性墨水、dirty tile、hash、同 tick 双向收敛、旧/相同 tile 不回声、旧 tile 合并和篡改拒绝；
- Rapier `GameWorld` 射击事件和 snapshot/restore 后继续确定性 step；
- 不兼容 analytic peer packet 被 Rapier session 拒绝；
- Rapier capsule 不能穿墙；
- Rapier projectile cast 返回正确的墙面 `surfaceId`。

`pnpm smoke` 继续验证真实双客户端 relay、owner 防伪、重连队伍、移动/潜水/爬墙、弹道和墨水行为。

## 后续边界

本 ADR 没有完成以下工作：

- WebRTC/Trystero adapter 与三 DataChannel；
- event log、输入量化、跨浏览器确定性回放；
- coordinator epoch/authority lease 的完整 host migration；
- 斜坡、台阶和移动平台 character-controller spike；
- GPU splat shader、法线/粗糙度和动态湿润墨水表现。

这些工作应扩展现有端口，不应重新把规则写回客户端入口或 transport。
