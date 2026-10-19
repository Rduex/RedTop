# 部署到 Cloudflare Pages（方案 A）

> 目标：给玩家一个**打开就能玩**的公开地址，且**不依赖 Railway**。
> 现在有两套入口，各管一件事：
>
> | 入口 | 内容 | 依赖 |
> | --- | --- | --- |
> | Railway（已有） | 联网版：联机排行榜 + 云存档 | 需要服务器，国内可能慢 |
> | **Cloudflare Pages（本文）** | 单机版：幽灵对战 + 本地榜 | **零后端，纯 CDN** |
>
> 两个可以同时存在。Railway 抽风时，玩家从 Cloudflare 那个地址照样能玩。

---

## 已经准备好的东西

仓库里这些文件就是为 Cloudflare Pages 准备的，**不需要你再改代码**：

| 文件 | 作用 |
| --- | --- |
| `dist-ghost/index.html` | 单机版（约 504KB 单文件，零网络请求） |
| `dist-ghost/_headers` | 缓存与安全响应头（构建时自动生成） |
| `dist-ghost/_redirects` | 任何路径都返回 index.html（构建时自动生成） |
| `tools/build-standalone.js` | 重新生成上面三个文件 |

`_headers` 里 **故意让 HTML 不长缓存**（`max-age=0, must-revalidate`）：
游戏更新靠的就是这个文件的字节变化，一旦设成一年，玩家会永远跑旧版本。
但"回源校验"不等于"重传"——CDN 侧有 ETag，命中就是 304。

---

## 方式一：Git 直连（推荐，一次配置永久生效）

1. 打开 <https://dash.cloudflare.com> → 左侧 **Workers & Pages**
2. **Create** → 选 **Pages** 标签 → **Connect to Git**
3. 授权并选中仓库 **`Rduex/RedTop`**
4. **Set up builds and deployments** 页填：

   | 字段 | 填什么 |
   | --- | --- |
   | Project name | `redtop`（决定域名 `redtop.pages.dev`） |
   | Production branch | `main` |
   | Framework preset | **None** |
   | Build command | `node tools/build-standalone.js` |
   | Build output directory | `dist-ghost` |

5. **Save and Deploy**，等 1~2 分钟
6. 拿到地址形如 `https://redtop.pages.dev`，打开即可玩

> 构建命令也可以**留空**，直接使用仓库里已提交的 `dist-ghost/`。
> 留空更快，但风险是"改了源码忘记重建"会发布旧版本。
> 用 `node tools/build-standalone.js` 更稳——Cloudflare 的构建环境自带 Node。

### 之后怎么更新

往 `main` 分支 push 就行。Cloudflare 会自动检测、重新构建、切换流量。

---

## 方式二：命令行直接上传（不想连 Git 时用）

```bash
npm i -g wrangler
wrangler login
wrangler pages deploy dist-ghost --project-name redtop
```

改动后重新跑这两条即可：

```bash
node tools/build-standalone.js
wrangler pages deploy dist-ghost --project-name redtop
```

---

## 验证部署是否正常

拿到地址后，按这三条自查：

```bash
# ① 能打开、体积是否被压缩（Cloudflare 默认开 brotli）
curl -s -o /dev/null -D - -H "Accept-Encoding: br" https://你的域名.pages.dev/ | \
  grep -iE "^HTTP|content-encoding|content-length"

# ② 单文件里不该有任何 /api 调用（这样才不依赖服务器）
curl -s https://你的域名.pages.dev/ | grep -c "FXOnline"     # 期望 0

# ③ 任意路径也能打开（_redirects 生效）
curl -s -o /dev/null -w "%{http_code}\n" https://你的域名.pages.dev/随便什么路径   # 期望 200
```

也可以用本仓库自带的探针直接验：

```bash
PAGE_URL=https://你的域名.pages.dev/ node tools/probe-live.js
```

---

## 常见问题

**Q：Cloudflare 上能不能有联机排行榜？**
能，但要额外接一个后端（Workers + D1/KV，或继续指向 Railway）。
这属于方案 C，不是本文范围。当前 Cloudflare 版本**只有本地榜**，这是刻意的取舍：
"打开就能玩"比"多一个联机榜"重要。

**Q：两个地址的数据互通吗？**
**不互通。** 存档按域隔离：
- Railway 的账号/云存档在浏览器 `redtop-production.up.railway.app` 下
- Cloudflare 的本地榜在 `xxx.pages.dev` 下

所以要把最常用的那个地址固定下来再推广，否则玩家的存档会"换地址就没了"。

**Q：国内访问 Cloudflare Pages 快吗？**
比 Railway 好，但不算快（免费版国内无节点，多走香港/新加坡）。
实测压缩后单文件约 150KB，国内首屏通常 1~2 秒。
如果要求更快，只能上国内 CDN，那需要域名 + ICP 备案。

**Q：`_headers` 和 `_redirects` 会被构建覆盖吗？**
不会。`build-standalone.js` 每次都会重新生成它们，内容恒定。
