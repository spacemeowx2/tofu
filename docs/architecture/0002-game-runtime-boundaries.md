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
| `PeerSession` | 给 transport 包补 owner、sequence、simulation tick、ink revision | Colyseus/WebRTC 细节、玩法校验 |
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
- 每位玩家的射速 cooldown、子弹序号、死亡/复活倒计时和出生槽位；
- `TiledInkField`；
- 当前 `LevelDefinition`；
- 构造时注入、之后不可替换的 `PhysicsAdapter`；
- `step()` 统一产生 shot、paint、hit、respawn、bullet-removed 事件；
- `snapshot()` / `restore()`，供重连、回放、host migration 和 server peer 接管。

浏览器和未来 server peer 都调用同一个 `GameWorld.step(commands, dt)`。一次调用可提交一个或多个 authority 玩家的原始移动、开火与瞄准意图，但全局 tick、武器 cadence 和所有子弹只推进一次；重复玩家命令只采用最后一条。客户端传本地玩家，server peer 可在同一 tick 批量传全部玩家。地面队伍、墙面接触和墙墨队伍均由 `GameWorld` 通过 `TiledInkField` 与 Rapier 派生，不接受客户端声称的环境状态。

### 数据定义

`LevelDefinition` 包含稳定地图 ID、边界、墙高、障碍物和双方出生点。渲染 mesh、解析碰撞器、Rapier collider、墙面 `surfaceId` 与墨水 grid 都从同一份定义生成。

`WeaponDefinition` 包含射速、伤害、弹速、半径、重力、寿命、射程衰减、散布、枪口位置，以及三种墨斑的主半径、卫星数、偏移和缩放范围。`WeaponCatalog` 随 `GameContentDefinition` 注入世界，`PlayerSnapshot` 明确携带 `weaponId`。协议中的 `WeaponId` 是开放字符串，因此增加武器不要求修改协议 union。仓库同时注册了 `splattershot` 与 `splattershot-jr`，架构测试会用第二武器和不同尺寸的第二关卡创建完整世界，防止定义只停留在类型层。

### 墨水归属与同步

`TiledInkField` 为地面和每个墙面保存：

- `owners: Uint8Array`：`0/1` 为队伍，`255` 为中性；
- `ticks: Uint32Array`：每格最后一次独立墨水 Lamport revision（保留旧字段名以维持 tile 格式）；
- `writers: Uint32Array`：同 revision 冲突的稳定 writer，保证双方按相同顺序收敛；
- dirty tile 集合；
- 每 tile FNV-1a hash；
- 全量世界快照、dirty tile 快照和校验后合并。

每个 packet 携带发送方的 `inkRevision` 上界，但普通 header 只做兼容性与范围校验；只有已经通过结构、owner、坐标和 hash 验证的 paint/tile 才能推进本地 revision，避免无关包把计数器推到上限。本地涂墨使用 `max(accepted)+1`，并限制在 tile 实际使用的 `Uint32` 范围。收到 tile 时会验证维度、边界、owner 值、revision、writer、数组长度和 hash。较旧 revision 不能覆盖较新格子；同 revision 由稳定 writer 决胜。没有改变任何格子的相同/陈旧 tile 不会重新标 dirty，避免 peer 之间持续回声。`GameWorld.applyPaint()` 返回裁决后的局部权威 tile，GPU 只消费这些 tile；原始 stamp 不能绕过 ownership 写永久纹理。潜水和爬墙只查询 `TiledInkField`，不读取像素颜色。

永久墨面只有一条表现路径：每个可涂面一张与玩法 grid 同尺寸的双通道 mask，`InkTextureRenderer` 用双线性采样和一个 shader 重建平滑边缘、湿润高光与边缘法线。`InkFluidVfx` 只在 impact 时用 Babylon 自带 `FluidRenderer` 生成固定容量、短寿命的体积喷溅；粒子从真实命中点沿入射方向展开并沉降，稳定 tile 延迟约 180ms 显露，但 VFX 绝不写回 tile。空闲时移除 FluidRenderer render object，不持续支付 depth/thickness/blur 成本。这样重连和局部快照只重建稳定墨面，瞬时效果丢失也不会改变玩法或归属。

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
ThirdPersonCamera ├─> GameController ─> GameWorld.step ─> GameWorldEvent ─> GameSession ─> PeerSession ─> GameTransport
                 │             │                    │
                 │             └─ TiledInkField     └─> GameRenderer
                 └──────── movement/aim                  │
                                                        └─ Babylon/GPU
```

远端数据按相反方向进入：`GameTransport -> PeerSession -> GameSession -> GameWorld -> GameRenderer`。渲染对象不反向写回模拟。

## 验证

`pnpm test:architecture` 会断言：

- render delta 被转换为稳定 fixed tick；
- 多 authority 命令在一个 `GameWorld.step()` 中只推进一次全局 tick，环境派生状态不来自输入；
- snapshot/restore 后连射 cooldown、子弹序号和复活倒计时不中断；
- 第二武器和不同尺寸第二关卡确实驱动出生点、UV 和完整世界；
- 中性墨水、dirty tile、hash、Lamport revision、同 revision 双向收敛、旧/相同 tile 不回声、旧 tile 合并、越界 revision 和篡改拒绝；
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
- 墨水 atlas 合批与更复杂的液滴/潜水特效。

这些工作应扩展现有端口，不应重新把规则写回客户端入口或 transport。
