# FX 战士久留美 · 联网版（排行榜）

把原来的**单机 HTML 游戏**变成**可联网的网页游戏**：多人排行榜、账号系统、
通关榜，并且**一行都不改原游戏代码**。

- 游戏本体：`FX模拟器V1.4.html`（原文件保持原样，可继续单独离线玩）
- 联网服务：本目录（零外部依赖，只用 Node 内置模块）
- 玩法：注册昵称 → 玩 → 每局峰值身家自动上榜 → 通关进通关榜

---

## 一、30 秒跑起来

**Windows**：双击 `启动联网版.bat`

**macOS / Linux / WSL**：`./start.sh`

**手动**：
```bash
node tools/build.js     # 生成联网版页面（把联网模块注入游戏单文件）
node src/server.js      # 启动服务器，默认 8787 端口
```

启动后控制台会打印两个地址：

| 地址 | 用途 |
| --- | --- |
| `http://127.0.0.1:8787` | 本机玩（**注意不是 3000**） |
| `http://<你的局域网IP>:8787` | **同一 WiFi 下手机/其他电脑直接打开** |

> 想让朋友一起玩，把局域网地址发给他们即可，不需要任何额外配置。

**想直接部署到公网？** 本目录已经初始化好 git 仓库并完成首次提交，三步即可上线：

```bash
cd D:\delta\fx-online
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

然后到 [Railway](https://railway.app) 或 [Render](https://render.com) 选中这个仓库部署，
平台会自动读 `railway.json` / `render.yaml` 完成构建与启动。
详细步骤（含**必须挂持久化卷，否则重部署清空排行榜**）见第六节。


---

## 二、它做了什么

### 排行榜

| 榜单 | 口径 |
| --- | --- |
| **总榜** | 每个账号取历史最好的一局（按本局峰值净资产排） |
| **周榜** | 最近 7 天内的最好一局 |
| **日榜** | 今天打出的一局 |
| **通关榜** | 只收录达成 $2,000 万的局，**按用时短优先**（谁最快赢回来） |

**身家口径** = 本局峰值净资产 = 现金 + 持仓保证金 + 浮动盈亏 + 家当市值 − 欠款
（与游戏内「通关目标 $2,000 万」用的是同一个数，不会出现两套口径打架）。

### 账号

- **昵称 + 密码**注册，不需要邮箱。
- 密码用 `scrypt` + 每用户随机盐哈希存储，**永不存明文**。
- 登录凭证是 HMAC 签名的无状态 token：服务端不存 session 表，
  **重启服务器不会把所有人踢下线**。
- 换台设备用同一昵称密码登录，成绩归到同一个账号。

### ☁ 云端存档（刷新不丢进度）

**解决的问题**：改造前游戏状态只活在页面内存里，一刷新或关掉标签页就回到 $10,000。

现在登录玩家的资金与持仓存在服务端，刷新后自动恢复：

| 时机 | 行为 |
| --- | --- |
| 页面加载 | `GET /api/account/state`，有存档就覆盖内存里的初始值并重绘界面 |
| 状态变化 | 每 1 秒检测 `balance`/`positions` 指纹，变了就**节流 3 秒**推送一次 |
| 关键交易 | 持仓数量变化（开仓/平仓/爆仓）时**立即**推送，不等节流 |
| 关闭页面 | `beforeunload` + `pagehide` → `navigator.sendBeacon` 发最后一次 |
| 网络失败 | 静默重试，指数退避 2s → 4s → … → 60s 封顶，全程不打扰玩家 |
| 未登录 | **完全不发请求**，纯内存游玩 |

**三个容易踩的坑，都已处理：**

1. **`locked`（占用保证金）必须按持仓重算。** 只恢复 `positions` 不恢复 `locked`，
   会出现"可用余额虚高 + 权益重复计算"的账目错乱。
2. **`seq`（仓位 id 游标）要推到已用最大值之后。** 否则新开仓会和恢复的仓位撞 id，
   平仓时平错对象 —— 这是很隐蔽的 bug。
3. **登录时必须先拉存档再上传。** 玩家可能以游客身份玩了一会儿才登录，
   若直接上传会用游客的 $10,000 覆盖他真正的云端进度。

> **注意 sendBeacon 的代价**：它无法自定义请求头，所以卸载兜底路径只能把 token
> 放在 URL 查询串里。这意味着 token 可能进入访问日志与浏览器历史。
> 缓解：token 有 90 天过期、且公网部署应强制 HTTPS。这是"卸载时仍能存上"的必要取舍。

### ＋追加保证金（手动追保）

**解决的问题**：游戏本体只在**危险度 ≥ 55%**时才渲染「＋追保 $X」按钮，而且点一下
就是"自动补到安全"。玩家想**主动**补一笔（刚开仓就想把强平价推远、或者只想补 200 块）
时，界面上没有任何入口。

现在每张持仓卡下方常驻一个「＋ 追加保证金」入口，随时可点：

| 能力 | 说明 |
| --- | --- |
| 任意金额 | 自己填，或点 25% / 50% / 全部可用 / 补到安全 |
| 追加前预览 | 保证金、强平价、危险度、剩余可用余额 —— 点之前就知道结果 |
| 余额保护 | 超出可用余额时确认按钮禁用，并写明还差多少（绝不偷偷把余额塞进去） |
| 账目一致 | 直接调用本体 `FX.topUpPosition()`：保证金 +x、占用 +x、**余额不变** |
| 数字跟行情 | 弹窗开着时危险度/可用余额每 1.2 秒刷新，但绝不覆盖你正在输入的金额 |
| 快捷键安全 | 弹窗内 Enter 被拦在输入框里（本体把 INPUT 里的 Enter 绑成了"开仓"） |

**实现方式**：`src/margin-ui.js` 作为注入模块挂在 `</body>` 前，**不改游戏本体**。
预览数值也不复制公式，而是给本体 `liqPriceOf()` / `dangerRatio()` 传一个
"保证金已加大"的浅拷贝 —— 本体哪天改了强平口径，弹窗里的数字自动跟着变。

> 为什么不改游戏本体：它是按字节保真的原始单文件（现在位于仓库根目录 `FX_game.html`），
> 同时是 Toy 版、离线版和历史对照的唯一源头。新增能力一律走"注入 + 复用已导出 API"。

### 两条重要设计

**① 离线优先。** 服务器不可达时游戏照常玩，成绩暂存在浏览器本地
（最多 30 条），联网后自动补交。不会有"网络抖一下，这局白打了"。

**② 不改游戏代码。** 联网模块是独立的一段脚本，追加在游戏脚本之后，
只**读取** `window.FX` 的公开状态。已验证构建产物里的游戏脚本块
与原文件**逐字节一致**（sha256 相同）。想退回纯单机版：删掉那段注入即可。

---

## 三、防作弊：能力与边界（请务必读）

当前采用的是**客户端上报 + 服务端合理性校验**。

### 能挡住

| 攻击 | 拦截依据 |
| --- | --- |
| 随手填个 `1e30` | 成绩硬上限（$10 万亿） |
| 开号即提交 | 最少 2 根 K 线（8 tick） |
| **谎报"极速"成绩** | tick 数与真实时长矛盾：游戏每 1.5 秒才走 1 tick，暂停只会更少，所以 `durationMs` 不可能小于 `tickCount × 1500`（留 10% 余量） |
| 谎报通关 | 声明 `won` 就必须真的达到 $2,000 万 |
| 数据自相矛盾 | 峰值不得低于结算权益（留 1% 浮点余量）、峰值不得低于开局资金的一半、K 线数不得超过 tick 数 |
| 刷榜 | 每账号每小时最多提交 60 局；同一局（同 `runId`）只算一条 |
| 冒名顶替 | 成绩只能记到自己的账号上，昵称由服务端从 token 反查 |
| 僵尸挂机 | 单局超过 45 天的成绩不记录 |

上表这些规则都有对应测试（`test/api.js` 里 8 条拦截用例全部通过）。

### **挡不住** —— 必须诚实说明

> 一个懂游戏内部机制的人，可以伪造一份**时间线自洽**的成绩
> （合理的 tick 数 + 合理的时长 + 合理的分数），服务端无法分辨。

这是"客户端上报"方案的固有上限，不是实现缺陷。想根治只有一条路：
**让服务端自己把这一局重算一遍**。相关的接口、数据结构和改造步骤已经预留好了：

- `src/verify.js` —— `ReplayVerifier`，含操作序列白名单与结构校验，
  `/api/replay` 接口已就位，当前返回 `verifier_disabled`（明确不假装已验证）。
- 需要游戏侧配合两项改造：
  1. **种子化随机数**：把游戏里十余处 `Math.random()`（行情 `gauss()`、
     事件调度、情报判定、卡牌抽取等）换成统一的 seeded PRNG；
  2. **全量操作上报**：把开仓/平仓/买卖资产/选卡等按 tick 顺序记下来一并提交。
- 好消息：**无头复算在 Node 里已被验证可行** —— 工作区里现存的
  `fx-equity-test.js`、`fx-boss-test.js` 等测试就是靠 DOM 桩把整份游戏
  跑在 Node 里再调用 `window.FX` 的钩子。同一手法可直接用于服务端复算。

**如果你的排行榜要发奖、要认真排名次，请务必先做这一步。**

---

## 四、目录结构

```
fx-online/
├── 启动联网版.bat        Windows 一键启动
├── start.sh               macOS / Linux 一键启动
├── 重新构建.bat            Windows 重新构建前端产物
├── package.json           依赖声明（无第三方依赖）+ postinstall 构建钩子
├── railway.json           Railway 部署配置（含健康检查）
├── render.yaml            Render 部署配置（含持久化磁盘）
├── .gitattributes         换行符规范化（保证 start.sh 到 Linux 是 LF）
├── .gitignore             排除 data/ 与可重建产物
│
├── FX_game.html           ★ 游戏本体，随仓库提交 —— 云上没有 D:\ 路径，靠它构建
│
├── src/
│   ├── server.js          HTTP 服务：路由、静态托管、限流、优雅关闭、PORT 支持、云存档接口
│   ├── auth.js            注册/登录：scrypt 哈希、HMAC 签名 token、?token= 兜底
│   ├── leaderboard.js     榜单口径 + 成绩合理性校验（防作弊核心）
│   ├── store.js           JSON 持久化：原子替换、防抖、损坏备份、云存档 + 旧数据迁移
│   ├── storage-check.js   启动自检：数据目录可写/是否真挂载卷（决定"重部署会不会丢档"）
│   ├── verify.js          权威复盘验证器（接口预留，当前未启用）
│   ├── theme-fx.css       新 UI 主题覆盖层（不改游戏本体样式）
│   ├── theme-canvas.js    拦截 canvas 取色，让 K 线跟着主题走
│   ├── margin-ui.js       ＋追加保证金：手动填金额、实时预览、复用本体账目
│   ├── mock-server.js     幽灵对战的本地存储（localStorage 假后端）
│   ├── ghost.js           幽灵录制与回放
│   ├── ghost-ui.js        幽灵对战界面
│   ├── ghost-bridge.js    把幽灵挂到游戏生命周期
│   └── online-client.js   浏览器端联网模块（被注入到游戏页面里）+ 云存档同步
│
├── tools/
│   ├── build-online.js    ★ 合并构建：主题 + 幽灵 + 追保 + 云存档 → public/index.html
│   ├── build-ghost.js     离线单文件版（按需生成到 dist-ghost/，不进仓库）
│   ├── game-src.js        游戏本体路径解析（全项目唯一一处候选列表）
│   ├── inject-guard.js    幂等注入：本体已合并过时先剥离再注入
│   ├── acceptance.js      ★ 端到端验收：起真服务端 + 真浏览器跑完整流程
│   ├── probe-*.js         浏览器探针（追保 / 线上体检 / 弹窗几何等）
│   └── shot*.js           截图 / 样式探针（CDP）
│
├── public/
│   └── index.html         预构建页面（随仓库提交，构建失败时也能托管）
│
├── test/
│   ├── store-close.js     退出落盘语义（无改动不写盘）
│   ├── margin-ui.js       ★ 追加保证金：口径一致、注入幂等、余额守护、Enter 不误开仓
│   ├── online-build.js    合并产物结构 + **幂等注入** + 注入顺序 + 真实后端端到端
│   ├── storage-check.js   数据目录自检
│   ├── secret-impact.js   密钥丢失的影响面
│   ├── theme.js / layout.js / desktop-layout.js   视觉与布局
│   ├── mock-ghost.js / ghost-e2e.js / ghost-integration.js   幽灵对战
│   └── api.js / account.js / smoke.js / e2e.js    接口与完整旅程（按需单跑）
│
└── data/                  运行期数据（自动生成，已在 .gitignore 里）
    ├── fx-online.json     玩家账号 + 成绩 + 云存档
    └── secret.key         token 签名密钥
```

---

## 五、HTTP 接口一览

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/health` | 否 | 健康检查（GET/HEAD 均可，供平台探活） |
| POST | `/api/register` | 否 | 注册，返回 token |
| POST | `/api/login` | 否 | 登录，返回 token |
| GET | `/api/me` | 是 | 当前账号信息 + 榜单名次 |
| POST | `/api/rename` | 是 | 改昵称 |
| POST | `/api/score` | 是 | 提交一局成绩（支持扁平/包裹两种形态） |
| GET | `/api/leaderboard` | 可选 | 榜单查询（`board`/`limit`/`offset`） |
| GET | `/api/profile` | 是 | 个人战绩与历史 |
| **GET** | **`/api/account/state`** | **是** | **读取云端存档：balance / positions / lastSyncAt** |
| **POST** | **`/api/account/sync`** | **是** | **写入云端存档（同步落盘 + 时间戳防乱序）** |
| **POST** | **`/api/account/reset`** | **是** | **重置为 $10,000 并清空持仓** |
| POST | `/api/replay` | 是 | 权威复盘（预留，当前返回未启用） |

**鉴权方式**：`X-FX-Token` 头或 `Authorization: Bearer <token>`；
`sendBeacon` 路径额外支持 `?token=`（因为它无法自定义 header）。

---

## 六、配置


全部通过环境变量，不需要改代码：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | — | **云平台标准变量**。Railway/Render/Heroku/Fly 都会注入它，并按其做健康检查。本项目已支持 |
| `FX_PORT` | `8787` | 本机想强制指定端口时用；**优先级高于 `PORT`** |
| `FX_HOST` | `0.0.0.0` | 监听地址。`0.0.0.0` = 局域网/公网可访问；只给本机用可设 `127.0.0.1` |
| `FX_DATA` | `./data` | 数据目录（账号与成绩存这里）。**云上务必指向持久化卷** |
| `FX_GAME_SRC` | 自动查找 | 构建时用的游戏源文件路径。不设时按 `FX_game.html`（仓库根目录）→ 本机原路径 的顺序查找 |
| `FX_API_BASE` | 空（同源） | 把 `public/` 挂到别的域名时，写死服务器地址 |

**端口优先级**：`FX_PORT` > `PORT` > `8787`。非法值会被忽略并打印警告。

例：
```bash
# 本机换个端口
FX_PORT=9000 FX_DATA=/var/lib/fx node src/server.js

# 云平台（平台自己会注入 PORT，你不用管）
node src/server.js
```


---

## 七、部署到公网

> **你在 Windows 上访问不了 `localhost:3000`——这是正常的，不是故障。**
>
> 本项目的服务默认监听 **8787**（且 `localhost:3000` 从来不是它的地址）。
> `3000` 是很多 Node 教程/前端脚手架的默认端口，容易记混。
> 本机要访问，请用下面这个地址：
>
> ```
> http://127.0.0.1:8787          ← 本机
> http://<控制台打印的局域网IP>:8787   ← 手机 / 同一 WiFi 的朋友
> ```
>
> 如果你确实想让本机跑在 3000 端口：`set FX_PORT=3000 && node src/server.js`（cmd）
> 或 `$env:FX_PORT=3000; node src/server.js`（PowerShell）。
>
> 部署到云平台后，**地址由平台分配**（形如 `https://xxx.up.railway.app`），
> 不会是 localhost。

服务本身零依赖、不需要数据库，任何能跑 Node 的地方都能部署。

---

### 方案 B：Git 仓库自动部署（你选择的方案）

**适用于：Railway / Render / Fly.io 等能从 Git 仓库直接部署的平台。**
只需把代码推到 GitHub，平台会自动构建并给你一个 HTTPS 地址。

#### 已经为你准备好的东西

| 文件 | 作用 |
| --- | --- |
| `FX_game.html` | **游戏本体（随仓库提交，位于仓库根目录）**。云上没有你的 `D:\delta\` 路径，靠它才能构建 |
| `public/index.html` | 预构建页面（随仓库提交）。万一平台没跑构建步骤也能直接托管 |
| `package.json` → `postinstall` | 平台装依赖时自动执行构建（Nixpacks/Heroku 系都会跑） |
| `railway.json` | Railway：构建命令、启动命令、**健康检查 `/api/health`** |
| `render.yaml` | Render：含**持久化磁盘**，防止重新部署清空排行榜 |
| `src/server.js` | 已支持平台注入的 **`PORT`** 环境变量（这是"部署后连不上"的头号原因） |

#### 操作步骤

**第 1 步：把代码推到 GitHub**

本目录已经初始化好 git 仓库并完成了首次提交。你只需要建个远程仓库再推上去：

```bash
cd D:\delta\fx-online

# 在 GitHub 上新建一个空仓库（不要勾选 README/gitignore），复制它的地址，然后：
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git branch -M main
git push -u origin main
```

**第 2 步：在平台上一键部署**

**Railway（推荐，配置最简单）**
1. 打开 https://railway.app → `New Project` → `Deploy from GitHub repo`
2. 选中刚推的仓库（首次需要授权 Railway 访问 GitHub）
3. **`Settings` 里 `Root Directory` 必须留空**（仓库根就是项目根）。
   构建靠 Railpack 自动执行 `npm run build`（`postinstall` 也会跑一次），
   启动命令在 `Deploy` → `Start Command` 填 `node src/server.js`
4. 部署完成后：`Settings` → `Networking` → `Generate Domain` 拿到公网地址

> `railway.json` 仍留在仓库里，但 Railway 已弃用 Config as Code（见下方"踩过的坑"），
> 真正生效的是面板设置。其他平台（Render/Heroku/Fly）仍可参考 `railway.json` 里的命令。

**Render**
1. 打开 https://render.com → `New` → `Blueprint`
2. 选中仓库，Render 会自动读 `render.yaml`（含磁盘挂载）
3. 免费档会休眠，闲置后首次访问有几十秒冷启动，属正常现象

**第 3 步（关键）：确认数据不会丢**

排行榜数据存在 `data/` 目录。**若平台没挂持久化卷，每次重新部署都会清空所有账号与成绩。**

- Railway：`Settings` → `Volumes` → 新建卷，**挂载路径填 `/app/data`**，并把环境变量
  `FX_DATA` 设为 `/app/data`
- Render：`render.yaml` 里已经配好磁盘（挂到 `/opt/render/project/src/data`，正是默认路径），无需手动操作

**第 4 步：验证**

访问 `https://<平台分配的域名>/api/health`，看到 `{"ok":true,...}` 就成功了。
其中 `storage` 字段是专门用来判"数据会不会丢"的，**必须**满足：

```json
"storage": { "dir": "/app/data", "writable": true, "mountPoint": true,
             "dbExists": true, "level": "ok", "fsType": "ext4 @ /app/data" }
```

- `mountPoint: true` —— 数据目录确实落在一个**挂载点**上（不是容器临时盘）
- `fsType` 里带 `@ /app/data` —— 卷真的挂在这个路径
- `level: "ok"` —— 自检结论允许这个位置持久化

任何一项不对，重新部署就会清空存档，而且日志里不会有别的提示。

#### 真机上踩过的三个坑（都已修好，记在这里避免重犯）

| 坑 | 现象 | 根因 | 正确做法 |
| --- | --- | --- | --- |
| **Root Directory 残留旧路径** | 每次 push 后线上毫无变化，构建日志只有一句 `Error: Failed to read app source directory` | 服务设置里 `Root Directory` 还留着旧仓库布局的 `/fx-online`，而仓库早已把项目放在根目录 | **Root Directory 留空**（仓库根 = 项目根）。否则构建必失败，平台继续跑上一次成功部署的旧镜像，看起来像"push 没生效" |
| **卷挂载路径与代码不一致** | 注册正常、存档正常，但重启后账号全没了 | 卷挂在 `/app/deta`，而代码读写 `/app/data`（`FX_DATA` 没设时的默认值）—— 写进容器临时盘，容器一换就没了 | 卷挂载路径与 `FX_DATA`（默认 `/app/data`）**必须一致**；改完看 `/api/health` 的 `storage.mountPoint` 确认 |
| **`railway.json` 已不再生效** | 改了配置里的构建/健康检查命令，线上行为没变 | Railway 已弃用 Config as Code（`railway.json` / `railway.toml`），改用 `.railway/railway.ts`；实际生效的是**面板设置** + Railpack 自动找 `npm run build` | 构建靠 `package.json` 的 `postinstall` / `build` 脚本（会自动跑 `build-online.js`），启动靠面板里的 Start Command `node src/server.js` |

#### 部署后的排查清单

| 症状 | 原因 | 怎么办 |
| --- | --- | --- |
| **Railway 报 502 Bad Gateway** | **你在环境变量里手动设了 `PORT`** | **删掉它。** 见下方专节 |
| **部署成功但页面打不开 / 502** | 服务没听平台要求的端口 | 本项目已支持平台注入的 `PORT`，无需手动设置 |
| 平台上显示 unhealthy / 健康检查失败 | 探活路径没配对 | 面板 `Deploy` → `Healthcheck Path` 填 `/api/health`（`railway.json` 已弃用，改它没用） |
| **push 了但线上没变化** | 构建失败，平台保留旧镜像 | 看构建日志有没有 `Failed to read app source directory`，有就清空 `Root Directory` |
| **重新部署后排行榜空了** | 没挂持久化卷 | 按上面第 3 步挂卷（Railway 最容易漏这步） |
| 还是连 `localhost` | 部署后地址是**平台域名**，不是 localhost | 用 `Generate Domain` 拿到的地址访问 |
| 构建失败：找不到游戏源文件 | 云上没有 `D:\delta\` | 已内置仓库根目录的 `FX_game.html`，确认它被一起提交了 |

#### ⚠️ Railway 502 的头号原因：手动设置了 `PORT`

**不要在任何云平台上手动设置 `PORT` 环境变量。**

Railway 会**自己注入 `PORT`**，并且**按它注入的那个端口做健康检查**
（见 [Railway 官方故障排查](https://docs.railway.com/networking/troubleshooting/application-failed-to-respond)）。
你在面板里把 `PORT` 改成 3000 之后：

1. 应用确实会监听 3000（本项目会正确读取这个值）；
2. 但 Railway 的健康检查仍然去拨**它自己注入的端口**；
3. 两边对不上 → 健康检查一直失败 → 对外返回 **502 Bad Gateway**。

这不是监听代码的问题 —— 本项目的监听逻辑是经过验证的：

| 检查项 | 实现 | 验证方式 |
| --- | --- | --- |
| 绑定地址不是回环 | `const HOST = process.env.FX_HOST \|\| '0.0.0.0'` | netstat 实测 `0.0.0.0:3000 LISTENING` |
| 读取平台端口 | `pickPort()` 读 `process.env.PORT` | 独立子进程实测 `PORT=3101` → 监听 3101 |
| 无硬编码端口/主机 | `server.listen(PORT, HOST, ...)` | 源码断言（日志里的 `127.0.0.1` 只是给人看的提示文本） |
| 探活路径可用 | `HEAD`/`GET /api/health` 均返回 200 | 实测 HTTP 200 |
| 监听失败不静默 | `server.on('error')` 打印人话并 `exit(1)` | 实测端口冲突时输出排查指引 |

**正确做法**：`Settings` → `Variables`，把 `PORT` 那一行**删掉**（不是改成别的值），
然后 `Redeploy`。若仍不通，再看 Railway 日志里我们的启动横幅：

```
  监听：    0.0.0.0:XXXX（端口来自平台注入的 PORT）
```

`XXXX` 应当与 Railway 面板里给你的目标端口一致。

> 本项目已在启动时主动检测这种误配：只要在云平台上检测到手动设了 `PORT`，
> 会在日志里打印警告与处理建议。


---

### 方案 A：自建云主机（最可控，适合长期运营）

```bash
# 1. 把 fx-online 目录传到服务器
scp -r fx-online user@your-server:/opt/

# 2. 装 Node 18+（Ubuntu/Debian）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 3. 用 systemd 常驻
sudo tee /etc/systemd/system/fx-online.service > /dev/null <<'EOF'
[Unit]
Description=FX Online Leaderboard
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/fx-online
Environment=FX_PORT=8787
Environment=FX_HOST=127.0.0.1
Environment=FX_DATA=/var/lib/fx-online
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=3
User=www-data

[Install]
WantedBy=multi-user.target
EOF

sudo mkdir -p /var/lib/fx-online && sudo chown www-data /var/lib/fx-online
sudo systemctl enable --now fx-online
```

前面挂 Nginx 提供 HTTPS（**公网务必上 HTTPS**，否则密码是明文传输）：

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;
    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;   # 限流靠它取真实 IP
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 方案 C：临时分享给朋友

```bash
npx localtunnel --port 8787     # 或 ngrok http 8787
```

⚠️ 临时隧道**没有 HTTPS 保障、地址是公开的**，只适合给朋友短时间试玩，
不要用来长期运营。

### 上线检查清单

- [ ] 走 HTTPS（公网传密码，这点不能省；Railway/Render 自动提供）
- [ ] `data/` 是持久化卷，重新部署不会清空
- [ ] 反向代理设置了 `X-Forwarded-For`（否则限流会把所有访客算成同一个 IP）
- [ ] 定期备份 `data/fx-online.json`（里面是所有账号与成绩）
- [ ] 若要认真排名/发奖 → 先启用 `src/verify.js` 的权威复盘


---

## 八、测试

```bash
npm test                      # 全部套件（约 1~2 分钟，会启动 Chrome 与真实服务端）
node tools/acceptance.js      # 端到端验收：起服务端 + 真浏览器跑完整玩家流程
node test/api.js              # 接口与部署配置专项
```

`npm test` 共 **437 项**断言，当前全部通过（11 个套件）：

| 套件 | 项数 | 覆盖 |
| --- | --- | --- |
| `test/store-close.js` | 11 | **退出落盘语义**：无改动不写盘、有改动必写、外部改写的文件不得被覆盖 |
| `test/margin-ui.js` | 64 | **追加保证金**：预览与本体口径一致、按钮注入幂等、余额守护、Enter 不误开仓、真实改账 |
| `test/online-build.js` | 46 | 合并产物结构、**幂等注入（本体自带模块时不得重复）**、注入顺序、真实后端端到端 |
| `test/storage-check.js` | 19 | 数据目录自检：可写性、挂载点判定、云平台识别、告警文案 |
| `test/secret-impact.js` | 17 | 密钥丢失的真实影响面（只会让 token 失效，不会丢账号） |
| `test/theme.js` | 59 | 主题令牌、对比度、红涨绿跌映射、Canvas 颜色代理 |
| `test/layout.js` | 22 | 移动端布局：关键卡片可见性、隐藏属性、换行 |
| `test/desktop-layout.js` | 34 | 桌面双栏：列宽、无重叠、无空洞 |
| `test/mock-ghost.js` | 92 | 幽灵本地存储（排行榜/录制/校验） |
| `test/ghost-e2e.js` | 37 | 幽灵回放端到端 |
| `test/ghost-integration.js` | 36 | 幽灵与游戏生命周期桥接 |

另外两套按需单跑（较慢，未放进 `npm test`）：

| 套件 | 覆盖 |
| --- | --- |
| `test/api.js` | 注册登录、鉴权、8 类伪造拦截、榜单排序、**部署配置与端口解析** |
| `test/account.js` / `smoke.js` / `e2e.js` | 云存档接口、完整玩家旅程、游戏本体完整性 |

浏览器探针（需要本机 Chrome）：`tools/probe-margin.js`（追保全链路 24 项）、
`tools/probe-live.js`（对线上地址做一次全功能体检）、`tools/acceptance.js`（端到端验收 26 项）。

---

## 九、改动记录（答疑用）

这一节记录构建过程中真实踩到并修掉的坑，都是会影响正确性的：

1. **`String.replace` 的 `$'` 展开把脚本写坏**
   注入时用了 `game.replace(re, inject)`。联网模块里有金额格式化
   `'$' + ...`，`$'` 被解释成"匹配之后的全部文本"并展开成半页 HTML，
   导致页面白屏。→ 改用**函数式替换** `replace(re, () => inject)`。
   并在构建期加了 `vm.Script` 语法自检，这类事故以后会让构建直接失败。

2. **包装 `window.FX` 上的导出函数拦不到真实结算**
   游戏逻辑全在 IIFE 闭包里，爆仓是内部 `checkRuin()` 直接调 `endCycle('ruin')`，
   根本不经过 `window.FX.endCycle`。→ 改为**周期观测 `state.cycle` 状态机**
   （`play` → `choosing`/`settled` 即判定一局结束），不侵入游戏。

3. **`state.won` 通关后永久为 true**
   拿它当"本局是否通关"，会让之后每一局都谎报通关，
   而服务端会因"未达标却声称通关"把成绩整条拒掉。→ 改为**按本局判断**
   （观测 `won` 由假变真的那个瞬间）。

4. **防抖落盘丢数据**
   注册后立刻强杀进程，120ms 防抖还没触发，账号整个消失。
   → 注册/登录/成绩/改名走**同步落盘**（`mutate(fn, {sync:true})`）。

5. **`/api/score` 把扁平上报体解析错**
   前端发的是 `{ score: 184320.55, tickCount, ... }`（扁平），
   服务端写成 `body.score || body`，把**数字**当成了整个上报体，
   tickCount/时长全变 0 → 每条真实成绩都被判"这一局太短"拒掉。
   → 以"`score` 是不是对象"区分两种形态，并加了专门的回归测试。

6. **`winKeys` 未持久化**
   通关去重表没跟着存档还原，重启后通关会重复计数。→ 补进 `_normalize`。

7. **测试桩的 `getElementById` 会凭空造元素**
   导致 `mountChip()` 里 `getElementById('fxoChip')` 永远为真、
   以为按钮已挂上就直接 return，**漏报了一个真实的挂载问题**。
   → 改为只认 HTML 里真实存在的 id，与浏览器行为一致。

以下 3 条是改用「方案 B：Git 仓库自动部署」时修掉的部署阻塞问题：

8. **服务端不认云平台注入的 `PORT`（"部署后连不上"的头号原因）**
   原先只读 `FX_PORT`，默认 8787。而 Railway/Render 不会设这个变量，
   它们只注入标准 `PORT`，**并按那个端口做健康检查** ——
   端口对不上 → 平台判定 unhealthy → 对外表现就是"连不上"。
   → 改为 `FX_PORT` > `PORT` > `8787` 的优先级，并加了端口校验与测试。

9. **构建依赖 `D:\delta\FX模拟器V1.4.html`（云上必然构建失败）**
   云平台只拿到 Git 仓库里的文件，本机绝对路径在那边不存在。
   → 把游戏本体放在仓库根目录并命名 `FX_game.html`（ASCII 文件名，避开中文名的编码坑）
   一起入库，构建按 `FX_GAME_SRC` → 内置副本 → 本机原路径 的顺序查找。
   已用"只复制 git 跟踪文件到干净目录"的方式实测通过。

10. **`start.sh` 的换行符会在 Linux 上崩掉**
    Windows 上 git 默认把文本转成 CRLF，而 CRLF 的 shell 脚本在 Linux 容器里
    会报 `bad interpreter: /usr/bin/env bash^M`。
    → 加 `.gitattributes` 强制 `*.sh` 用 LF、`*.bat` 用 CRLF，并验证了索引里的实际换行符。

11. **HEAD 请求落到 404，会让健康探针判定不健康（→ 502）**
    路由原先严格按 `(method, pattern)` 匹配，`HEAD /api/health` 直接 404。
    部分负载均衡器与监控探针用 HEAD 探活 → 探针认为服务挂了 → 对外 502。
    → 按 HTTP 语义把 HEAD 映射为 GET，实测 `HEAD /api/health` 返回 200。

12. **监听失败静默，日志里看不出原因**
    没有给 server 挂 `'error'` 监听时，`EADDRINUSE` / `EACCES` 只会抛一个
    无语境的异常。而部署平台上**你只有日志**可看 —— 典型表现就是
    "进程活着、页面 502、日志里啥也没有"。
    → 现在会打印端口冲突的人话解释、当前生效的全部配置，
    并明确 `exit(1)` 让平台判定部署失败而不是留个僵尸进程。

13. **`postinstall` 构建失败会连带把安装步骤也搞失败**
    包管理器的 `postinstall` 非零退出会导致安装失败。
    → 改为失败时打印提示但不阻断（仓库里已有提交好的 `public/index.html` 兜底）。

**云存档重构（v1 → v2）期间修掉的坑：**

14. **迁移只补内存、不回写磁盘，磁盘与内存不一致**
    `_normalize()` 给旧账号补了 `balance/positions`，但那是纯内存操作。
    运维用文本工具看数据文件时看到的还是缺字段的旧结构，会误判"迁移没生效"。
    → 加 `_needsPersist` 标记：检测到版本升级或账号缺字段时，**读完立刻回写**一次。

15. **只恢复 `positions` 不恢复 `locked`，账目直接算错**
    游戏里 `locked`（占用保证金）是独立字段。恢复持仓却不重算它，
    会出现"可用余额虚高 + 权益重复计算"。
    → `applySaveToGame()` 里按持仓 `margin` 求和重算 `locked`。

16. **恢复仓位后 `seq` 游标没跟上，新仓会撞 id**
    撞 id 的后果是"平仓平错对象"，非常隐蔽。
    → 把 `seq` 推到已恢复仓位的最大 `id` 之后。

17. **登录时直接上传会覆盖真实云端进度**
    玩家可能先以游客身份玩了一会儿才登录。若此时直接上传，
    会用游客的 $10,000 覆盖他真正的存档。
    → 登录流程改为**先 `loadAccountState()` 拉取**，服务端没有存档时才把本地状态作为初始存档推上去。

18. **`sendBeacon` 无法自定义请求头**
    卸载兜底只能用 `sendBeacon`，但它设不了 `X-FX-Token`。
    → `auth.js` 的 `userFromRequest()` 增加 `?token=` 查询参数兜底
    （代价是 token 可能进访问日志，已在文档中说明缓解措施）。

---

## 十、常见问题

**Q：必须注册才能玩吗？**
不必须。不登录照样玩，成绩暂存在浏览器本地，登录后自动补交。

**Q：我访问 `localhost:3000` 打不开？**
本项目的服务默认在 **8787**，不是 3000。本机请用 `http://127.0.0.1:8787`；
部署到云平台后地址由平台分配（如 `https://xxx.up.railway.app`）。
想改到 3000：`set FX_PORT=3000 && node src/server.js`。

**Q：Railway 报了 502 Bad Gateway，是不是监听写死了 localhost？**
不是。本项目的监听地址是 `0.0.0.0`、端口读的是 `process.env.PORT`，
两者都经过实测（详见第六节的验证表）。
502 几乎总是因为**你在 Railway 面板里手动设置了 `PORT` 环境变量**——
Railway 会自己注入 `PORT` 并按那个端口探活，手动改会导致端口不一致。
**把那个环境变量删掉再 Redeploy** 即可。

**Q：手机能玩吗？**
能。排行榜弹窗在窄屏下自动变成整屏面板，不遮挡游戏操作。
用局域网地址在手机浏览器打开即可。

**Q：原来的单机版还在吗？**
在。`FX模拟器V1.4.html` 原封未动，双击照常离线玩。

**Q：怎么才能让人没法作弊？**
见第三节。需要先给游戏接入种子化随机数 + 操作上报，
然后打开 `src/verify.js` 的开关。目前的校验只能挡住"不合逻辑"的成绩。

**Q：数据存哪？怎么备份？**
`data/fx-online.json`。直接 `cp` 走就是完整备份，
里面是账号（含盐与哈希，无明文密码）和全部成绩。

**Q：想换游戏版本怎么办？**
改完 `FX模拟器V1.4.html` 后重新 `node tools/build.js` 再重启服务即可，
联网模块会自动注入到新版本上。
