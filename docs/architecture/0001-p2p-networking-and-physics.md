# ADR 0001: P2P 联机与物理引擎架构

- 状态：暂定采用，需通过技术 spike 后正式确认
- 日期：2026-07-14
- 范围：浏览器客户端、联机协议、物理碰撞、涂地同步

## 背景

Tofu Arena 的目标是制作一个开源的 Web 多人涂地射击项目。核心玩法包括第三人称移动、射击、墨水覆盖、伤害和多人对战。

项目希望参考 Splatoon 的 P2P 联机思路，而不是把游戏模拟长期托管在权威服务器上。首版采用 `honest-peer` 假设，优先解决正常玩家在延迟、丢包、NAT 和断线条件下的正确联机；恶意客户端检测和裁决留给后续社区方案，但协议必须从一开始支持记录、回放、校验和替换裁决模块。

当前 Hello World 使用 Babylon.js 客户端和 Colyseus 权威房间。它是控制、射击和扣血的验证原型，不代表目标架构。

## 参考边界

Splatoon 没有公开完整联网实现。可获得的 Splatoon 2 逆向研究表明：

- Nintendo 的 pia 提供 P2P 会话，同时选出一个 host 负责会话协调。
- NEX 负责匹配和 NAT 穿透等控制面功能。
- 游戏通过可订阅的 clone 复制状态，并使用有序 Event clone 处理子弹生成、涂墨和伤害。
- 游戏和网络处理以 60 Hz 推进，普通 clone 数据约每四 tick 合并发送一次。
- 会话支持 host migration。

这些信息用于提取设计模式，不用于宣称本项目复刻 Nintendo 的私有协议。Splatoon 3 使用 NPLN，但其战斗同步细节没有完整的一手公开文档。

参考资料：

- [Splatoon 2's Netcode and Matchmaking: An In-Depth Look](https://oatmealdome.me/blog/splatoon-2s-netcode-an-in-depth-look/)
- [Nintendo: Compatibility Between NAT Types](https://en-americas-support.nintendo.com/app/answers/detail/a_id/12472/)

## 决策

### 总体技术栈

| 领域 | 选择 | 职责 |
| --- | --- | --- |
| 渲染 | Babylon.js | 场景、材质、动画、摄像机和输入 |
| 碰撞 | `@dimforge/rapier3d` | 地图碰撞、capsule 查询、ray cast 和 shape cast |
| 角色运动 | 自定义 kinematic controller | 加速、制动、空中控制、斜坡、游泳和墨水加成 |
| 实时传输 | WebRTC DataChannel | 浏览器之间的战斗数据 full mesh 传输 |
| 控制面 | Colyseus | 房间发现、匹配、WebRTC 信令和初始配置 |
| NAT 穿透 | STUN + TURN | 优先直连，失败时中继，并提供强制中继隐私模式 |
| 涂地 | 独立墨水归属系统 | 墨水事件、GPU 纹理、tile 校验和及局部重同步 |

Rust 不是业务代码的前置要求。Rapier 通过 TypeScript/JavaScript API 和 WebAssembly 使用；只有在未来需要修改物理核心或实现共享的高性能校验模块时，才评估增加 Rust crate。

### P2P 拓扑

目标对局上限首先按 8 名玩家设计。每名玩家与其他玩家建立一条 `RTCPeerConnection`，形成 full mesh：8 人共 28 条点对点连接，每个 peer 维护 7 条连接。

Colyseus 不再推进权威游戏世界。它保留低流量控制连接，用于：

- 创建、发现和加入房间；
- 交换 SDP offer/answer 和 ICE candidate；
- 分发房间协议版本与初始配置；
- 记录在线状态，并辅助重新加入会话。

房间选出一个 coordinator host。host 负责会话 epoch、逻辑时钟、全局事件排序、开局/结算和迁移，不负责作为唯一物理真相来源。host 离开后，剩余 peers 根据确定性的候选排序选择新 host。

直接 P2P 会向对端暴露可连接的 IP 地址。产品必须明确提示这一点，并提供强制 TURN 的隐私中继模式。TURN 会增加服务带宽成本，但不能省略，否则严格 NAT 或防火墙环境中的玩家无法可靠加入。

参考资料：

- [WebRTC 1.0: RTCDataChannel](https://www.w3.org/TR/webrtc/#rtcdatachannel)
- [RFC 8831: WebRTC Data Channels](https://www.rfc-editor.org/rfc/rfc8831.html)
- [RFC 8828: WebRTC IP Address Handling Requirements](https://www.rfc-editor.org/rfc/rfc8828.html)
- [RFC 8656: TURN](https://www.rfc-editor.org/rfc/rfc8656.html)

### 传输通道

每条 peer 连接建立三个逻辑通道：

| 通道 | DataChannel 设置 | 数据 |
| --- | --- | --- |
| `state` | `ordered: false, maxRetransmits: 0` | 位置、朝向、速度、姿态和短期预测输入 |
| `event` | 可靠、有序 | 开枪、墨水落点、伤害、死亡、复活和对象生成 |
| `control` | 可靠、有序 | 时钟、peer 加入退出、快照请求、host 迁移和结算 |

本地模拟固定为 60 Hz。运动快照从 15 至 20 Hz 起步，通过插值和有限外推显示远端角色。事件不能依赖下一次位置快照顺带送达；它们有独立序列号并通过可靠通道传输。

协议使用二进制编码并包含：

- `protocolVersion`
- `matchId` 和 `epoch`
- `peerId`
- `sequence`
- `simulationTick`
- `eventId`
- 事件负载及其规范化 hash

任何通道都必须监控 `bufferedAmount`。状态通道在积压时丢弃旧快照，不允许旧位置阻塞新位置；可靠通道发现序列缺口时请求补发或局部快照。

### 所有权和首版信任模型

首版采用以下所有权：

- peer 拥有自己的移动状态和射击输入；
- 射击 peer 产生子弹、墨水和命中声明；
- coordinator host 拥有比赛时钟、全局事件序和比赛阶段；
- 每个 peer 独立应用收到的事件并保存事件日志。

这是可玩的 casual 模式，不提供可信排名保证。为了让社区以后增加验证机制，游戏规则不能直接写进传输层。至少保留以下接口：

- `MovementValidator`
- `ShotValidator`
- `HitValidator`
- `PaintValidator`
- `MatchArbiter`
- `ReplayRecorder`
- `StateHasher`

后续实现可以选择 host 裁决、目标方确认、多 peer 仲裁、旁观裁判节点或赛后回放审计，而不需要替换 WebRTC 传输和玩法模拟。

### 物理与角色控制

选择 Rapier 的理由：

- Apache-2.0，核心源码可由社区审计和修改；
- JavaScript/WASM 版本提供跨平台确定性保证，但要求版本、初始值和对象创建顺序相同；
- 自带 character controller、ray cast、shape cast、过滤和快照能力；
- 可以同时支撑浏览器实时模拟和离线回放工具；
- 维护状态优于 cannon-es，Web 集成成本低于 Jolt。

Rapier 不拥有最终的玩家手感。玩家使用 capsule 或相近的简单 collider，自定义状态机计算期望位移，再由 Rapier character controller 或 shape cast 修正碰撞位移。Rapier 官方 character controller 只处理平移，正好保持摄像机朝向、角色转身和游戏状态机的独立性。

高速墨水弹默认不创建动态刚体。发送规范化的射击事件后，各 peer 使用固定步长解析轨迹和 shape cast 求交；需要弹跳或复杂物理的特殊武器再单独建模。

跨 peer 重放不能只依赖 Rapier 的确定性。网络向量必须量化，随机数必须使用显式种子，物理对象必须按稳定 ID 排序创建，确定性路径中不得直接依赖可能跨平台产生差异的 `Math.sin`、`Math.cos` 等超越函数。

参考资料：

- [Rapier JavaScript determinism](https://rapier.rs/docs/user_guides/javascript/determinism/)
- [Rapier character controller](https://rapier.rs/docs/user_guides/javascript/character_controller/)
- [Rapier scene queries](https://rapier.rs/docs/user_guides/javascript/scene_queries/)
- [Rapier.js changelog](https://github.com/dimforge/rapier.js/blob/master/CHANGELOG.md)

### 墨水同步

墨水不是刚体或流体模拟。地表维护可查询的队伍归属与更新时间数据，渲染纹理只是它的可视化结果。

网络发送射击或墨水 stamp 事件，而不是逐像素纹理：

1. 事件携带武器、起点、方向、种子、tick 和稳定 ID。
2. 每个 peer 用相同笔刷规则更新本地归属纹理。
3. 地图按 tile 计算周期性 hash。
4. hash 不一致时只请求有差异的 tile 快照。
5. 比赛结算从归属数据统计覆盖率，不从屏幕颜色采样。

墨水事件、物理状态和渲染资源必须分层，避免更换物理引擎或可信方案时重写涂地系统。

## 未选择的方案

### Babylon Havok

它与 Babylon.js 的集成最直接，但不提供与 Rapier 相同的社区可修改物理核心和公开的 JavaScript 跨平台确定性承诺。对于计划开放协议、重放和可信实验的项目，不作为默认底座。

### cannon-es

纯 TypeScript、体积小且容易阅读，但正式版本和功能演进较慢，缺少同等级的 character controller、复杂 scene query 和确定性说明。保留为简单原型参考，不作为主引擎。

### Jolt Physics

C++ 核心活跃、MIT 且性能优秀，但当前 JavaScript/WASM 绑定、包体和 Babylon.js 集成成本更高。若 Rapier 在 8 人场景的性能 spike 中失败，再将 Jolt 作为第二候选验证。

### 完全确定性 lockstep

不作为首版同步方式。第三人称射击对输入延迟敏感，完整回滚墨水纹理和全部角色状态的成本也较高。首版使用 owner snapshot + ordered event 的混合复制；确定性和 hash 用于重放、发现分歧和未来验证，而不是让最慢 peer 阻塞所有玩家。

## 技术 spike 与通过标准

在把当前权威房间迁移为 P2P 前，建立独立 spike，至少验证：

1. 两个真实浏览器通过 Colyseus 信令建立直连，并能在强制 TURN 模式下连接。
2. 8 个 peer 建立完整 mesh，持续运行 10 分钟，DataChannel 不出现持续增长的积压。
3. 注入 50/100/200 ms 延迟、抖动和 2%/5% 应用层丢包，运动保持可操作，可靠事件最终无缺口。
4. host 主动退出后完成迁移，不重置比赛和事件序列。
5. 同一事件日志在两个独立浏览器重放 10,000 tick，Rapier 快照 hash 和墨水 tile hash 一致。
6. capsule 在斜坡、台阶、墙角、下落、贴地和移动平台测试关卡中行为稳定。
7. 使用预期上限的射速和墨水 stamp 数量测量 CPU、带宽、WASM 初始化时间及浏览器内存。
8. 地图 collider 能从共享关卡数据稳定生成，peer 间创建顺序一致。

如果确定性重放失败，先定位游戏层非确定性，不立即更换物理引擎。如果 Rapier 的查询或模拟性能达不到预算，再对 Jolt 做同一套测试。

## 迁移顺序

1. 将共享消息升级为带版本和序列号的二进制协议。
2. 抽象 `Transport`，保留 Colyseus transport 供现有 smoke test 使用。
3. 增加 WebRTC signaling 和三通道 peer transport。
4. 将移动和射击模拟移入共享 simulation package。
5. 引入 Rapier adapter 和自定义 kinematic player controller。
6. 加入事件日志、重放和 hash 工具。
7. 实现 host election/migration 和 TURN 隐私模式。
8. 通过 spike 后移除 Colyseus 权威战斗循环，仅保留控制面。

## 结论

暂定目标架构为 Babylon.js + Rapier + WebRTC full mesh + Colyseus 控制面 + 独立墨水归属系统。该决策只有在上述 spike 通过后才从“暂定采用”变为“已采用”。
