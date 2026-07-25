# ADR 0002: 可扩展游戏运行时边界

- 状态：采用并已落地
- 日期：2026-07-25
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
| `GameRenderer` | Babylon 场景、关卡 mesh、角色/子弹插值、墨水纹理 | 决定命中、地面归属或移动 |
| `main.ts` | 创建上述对象、把世界事件连接到网络和视图 | 保存第二份玩法世界 |

`GameTransport` 仍是网络端口；`PeerSession` 是连接玩法入口与该端口的会话层。替换成 WebRTC adapter 时，输入、世界和渲染模块不变。

### 共享模拟层

`GameWorld` 拥有：

- 当前 tick；
- `players` 与 `bullets`；
- `TiledInkField`；
- 当前 `LevelDefinition`；
- 可替换的 `PhysicsAdapter`；
- `shoot()` 和 `step()` 产生的 paint、hit、bullet-removed 事件；
- `snapshot()` / `restore()`，供重连、回放、host migration 和 server peer 接管。

浏览器和未来 server peer 都调用同一个 `GameWorld.step()`。客户端不再分别推进玩家和子弹，也不直接进行墙体碰撞查询。

### 数据定义

`LevelDefinition` 包含稳定地图 ID、边界、墙高、障碍物和双方出生点。渲染 mesh、解析碰撞器、Rapier collider、墙面 `surfaceId` 与墨水 grid 都从同一份定义生成。

`WeaponDefinition` 包含射速、伤害、弹速、半径、重力、寿命、射程衰减、散布、枪口位置和三种涂墨参数。协议中的 `WeaponId` 是开放字符串，模拟层 registry 负责拒绝未知武器，因此增加武器不要求修改协议 union。

### 墨水归属与同步

`TiledInkField` 为地面和每个墙面保存：

- `owners: Uint8Array`：`0/1` 为队伍，`255` 为中性；
- `ticks: Uint32Array`：每格最后更新时间；
- dirty tile 集合；
- 每 tile FNV-1a hash；
- 全量世界快照、dirty tile 快照和校验后合并。

收到 tile 时会验证维度、边界、owner 值、tick、数组长度和 hash。较旧 tick 不能覆盖较新格子。`InkTextureRenderer` 消费 stamp 或 tile，并负责唯一的世界坐标到 Canvas 纹理变换；潜水和爬墙只查询 `TiledInkField`，不读取像素颜色。

当前 relay demo 在 roster 改变时发送完整 tile snapshot，保证新 peer 能获得已有墨水。后续 WebRTC control 通道应先交换 tile hash，只请求不同 tile。

### 物理

`PhysicsAdapter` 暴露三类规则所需查询：

- capsule 期望位移修正；
- 可附着墙面探测；
- 高速墨水弹 shape cast。

`RapierPhysicsAdapter` 从 `LevelDefinition` 创建静态 cuboid collider，使用 capsule/ball shape cast，且不创建动态子弹刚体。`AnalyticPhysicsAdapter` 只作为 WASM 初始化失败时的降级和对照测试。两者实现同一接口，因此 simulation 不依赖 Babylon、DOM、Colyseus 或 Node。

## 状态流

```text
InputController ─┐
ThirdPersonCamera ├─> GameWorld.step/shoot ─> GameWorldEvent ─> PeerSession ─> GameTransport
                 │             │                    │
                 │             └─ TiledInkField     └─> GameRenderer
                 └──────── movement/aim                  │
                                                        └─ Babylon/GPU
```

远端数据按相反方向进入：`GameTransport -> PeerSession -> GameWorld -> GameRenderer`。渲染对象不反向写回模拟。

## 验证

`pnpm test:architecture` 会断言：

- render delta 被转换为稳定 fixed tick；
- 关卡/武器 registry 可用；
- 中性墨水、dirty tile、hash、复制和篡改拒绝；
- `GameWorld` 射击事件和 snapshot/restore；
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
