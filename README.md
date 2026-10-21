# Web To OpenAPI —— 把任意网页能力封装成 OpenAPI / MCP 的浏览器插件 + 本地服务

> **支持 Edge 与 Chrome（及其它 Chromium 内核浏览器）**。文中出现「Edge」的地方均可替换为 Chrome，二者用法完全一致——安装包里只有一份扩展，两个浏览器都能加载。

把浏览器里的任意网页能力（需要登录的控制台、搜索引擎结果页、动态渲染的页面……），包装成**本地 HTTP 服务**对外提供：一套代码，**同时**暴露 OpenAPI（REST）与 MCP 两套接口。

- **两套接口，同一进程同一端口**：REST 供 `curl` / 任何语言调用；`/mcp` 端点供 MCP 客户端直接接入（也可用 `mcp-stdio.js` 以 command 方式接入）；
- **不依赖任何浏览器驱动**：走浏览器扩展（Edge / Chrome）+ native messaging，用的是**你在浏览器里已有的登录态**，不需要再处理 Cookie / 验证码 / 2FA；
- **底层复用 chrome-mcp-server（mcp-chrome-bridge）的浏览器操作接口**：native messaging `CALL_TOOL` → 扩展执行 `chrome_navigate` / `chrome_javascript` / `chrome_read_page` 等内置工具（协议与 mcp-chrome-bridge 同源）；
- **监听地址 / 端口可在「插件设置」里配置**：通过扩展 Options 页写入，保存后自动生效，**无需手改任何文件**；
- **全部跑在本机**：默认只监听 `127.0.0.1`，不对外暴露，不上传任何数据。

> **适用边界**：它解决的是「没有公开 API、但又想用程序拿到数据」这类场景——**前提是你本人在浏览器里对该站点有合法访问权限**。请仅用于你有权限访问的账号与服务，并遵守目标站点的使用条款。

> 一句话：**安装一次，之后每次打开浏览器（Edge 或 Chrome）自动可用**；地址和端口在插件设置里改，不用碰命令行。

## 文档导航

| 文档 | 讲什么 | 什么时候看 |
|---|---|---|
| **README.md**（本文） | 原理、架构、功能、安装、行为配置、使用示例 | 第一次用；想知道它怎么工作、有哪些能力 |
| **[API.md](API.md)** | 完整端点清单、每个参数的语义、返回字段、语言代码表、MCP 接入与工具清单 | 已经装好了，要写代码调接口 |
| **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)** | 日志位置、症状速查表、三层排查、`cmd 有 node 但浏览器找不到` 的原理与修法、常见问题 | 装不上、服务起不来、接口报错 |

## 架构

```
HTTP 客户端 (curl / 你的代码 / 其他服务)
      │  GET /api/v1/scnet/balance ...  (示例接口; 更多 Web API 陆续加入)
      ▼
openapi-host.js ── lib/(基础设施) ── sites/(一个网页一个文件)
  (Node, 地址/端口由「插件设置」决定, 默认 127.0.0.1:8090)
      │  native messaging(stdio): {type:"call_tool", payload:{name,args}, requestId}
      ▼
浏览器扩展(web-to-openapi/extension, 独立副本, 不提供 MCP; Edge / Chrome 通用)
      │  chrome.tabs / chrome.scripting / chrome.debugger ...
      ▼
真实浏览器(Edge 或 Chrome, 已登录对应网站的登录态)
```

## 能力一览（当前已封装）

同一个进程里，下面这些能力既能用 REST 调，也能以 MCP 工具形式被模型调用：

| 能力 | 端点 | 拿到什么 |
|---|---|---|
| **需要登录的控制台数据** | `GET /api/v1/scnet/{free-credit,token-plan,balance}` | 直接读你在浏览器里已登录的 SCNet 控制台余额，不碰密码、不存 Cookie |
| **搜索引擎** | `GET\|POST /api/v1/search/{baidu,google}` | 结构化结果（标题 / 链接 / 摘要 / 日期 / 是否广告）+ 完整高级参数（`site:` `intitle:` `filetype:` 时间范围、分页、真实 URL 解析……） |
| **在线翻译** | `GET\|POST /api/v1/translate` | 54 种语言，附音标、简明释义、双语例句、译法解析 |
| **任意浏览器操作** | `POST /api/v1/tools/{name}` | 透传 `chrome_navigate` / `chrome_javascript` 等底层工具——临时抓一个页面不必先固化成端点 |
| **自描述** | `GET /openapi.json` · `GET /docs` | OpenAPI 3.0 规范（可导入 Postman / Apifox）+ 可在线试调的文档页，与代码同源、不会过期 |

> 这套东西的价值在于**复用你已有的登录态**：任何"能在浏览器里手动看到、但没有公开 API"的数据，都能按同一套机制变成接口。新增一个网站 = 在 `host/sites/` 加一个文件，路由 / MCP 工具 / OpenAPI / 文档页四处自动生效（见后文「新增一个网页」）。
>
> 完整参数与返回字段见 **[API.md](API.md)**。

## 目录

| 路径 | 说明 |
|---|---|
| `extension/` | 独立浏览器扩展（**Edge / Chrome 通用**；从 `chrome-mcp-server-1.0.0` 复制改造：新密钥/新 ID、宿主名改为 `com.webtoopenapi.host`、品牌重命名为 Web To OpenAPI、内置 Options 设置页） |
| `host/openapi-host.js` | **启动入口（薄）**：装配站点注册表 → native messaging → HTTP 服务 |
| `host/lib/` | 基础设施：`config` 配置 / `log` 日志 / `nm` native messaging 命令通道 / `util` 浏览器操作（开页·执行 JS·重试提取·链接还原）/ `defaults` 默认参数三层合并 / `registry` 站点注册表 / `mcp` MCP 协议 / `spec` `/openapi.json` / `docs` `/docs` 文档页 / `tools` 浏览器工具目录 / `http` 路由分发 |
| `host/sites/` | **一个网页一个文件**：`scnet.js` / `baidu.js` / `google.js` / `translate.js`（在线翻译，内部用引擎表聚合多站点）+ 服务自身的 `_service.js`。新增能力只在这里加文件，见「新增一个网页」 |
| `host/mcp-stdio.js` | MCP stdio 桥接入口（独立进程，零依赖）：把 MCP 客户端的按行 JSON-RPC 转发到 `/mcp`，供 Claude Desktop 类客户端以 command 方式接入 |
| `host/config.json` | 监听地址/端口（`host` / `port` / `tool_timeout_ms`）、页面打开策略（`page_mode`）、标签页复用窗口（`keep_tab_ms`）。后两者可被「扩展设置页 → 浏览器行为」覆盖（优先级：设置页 > 本文件 > 环境变量 > 内置默认） |
| `host/run_host.bat` | 浏览器拉起 host 的启动器：node 从 PATH 解析（可选 `node-path.txt` / `WEBTOOPENAPI_NODE` 覆盖）；Edge / Chrome 走同一个 |
| `host/com.webtoopenapi.host.json` | native messaging manifest（`allowed_origins` = 扩展 ID，安装时自动推导，无需手改） |
| `host/install-host.ps1` | 注册/注销 native host（写 HKCU 注册表，无需管理员，Edge + Chrome 双键） |
| `tools/gen-key.mjs` | （可选）生成自己的扩展密钥 + 计算扩展 ID，可一键写回两处配置 |
| `tools/probe_baidu.py` | SERP 探针：新增搜索引擎时用它先摸清结果页 DOM 结构 |
| `tools/build-dist.py` | 打包发布 zip（产物不入库） |
| `API.md` | **接口分册**：端点清单、参数、返回字段、MCP 接入 |
| `TROUBLESHOOTING.md` | **排障分册**：日志、症状速查、三层排查、常见问题 |

## 部署（**只需一次**）

1. **注册 native host**（需要本机装了 Node.js，且 **node 在 PATH 里**；写入当前用户注册表，无需管理员）

   > ⚠️ **最容易踩的坑：cmd 里 `node -v` 能用，不代表浏览器能用。**
   > host 由浏览器拉起，继承的是**浏览器进程**的环境变量，不是你现在这个终端的环境。
   > 判定与修法见 **[TROUBLESHOOTING.md → 为什么 cmd 里 node 能跑，浏览器却说找不到](TROUBLESHOOTING.md#为什么-cmd-里-node-能跑浏览器却说找不到)**。改完 PATH 必须**完全退出浏览器**（任务管理器里不能剩 `msedge` / `chrome` 进程）才会生效。
   - 最简单：**双击 `host\install.bat`** 即可（内部自动 bypass 执行策略跑 ps1）。
   - 或手动执行：
   ```powershell
   powershell -ExecutionPolicy Bypass -File host\install-host.ps1
   ```
   - 卸载：双击 `host\uninstall.bat`（或上面的 ps1 加 `-Uninstall`）。
   - 脚本会把 `run_host.bat` 的真实绝对路径写回 manifest，并**根据扩展 key 自动推导扩展 ID**写入 `allowed_origins`——包解压在任何目录都能用。
   - **Edge 和 Chrome 两个键会一起写上**（`HKCU\Software\Microsoft\Edge\NativeMessagingHosts` 与 `HKCU\Software\Google\Chrome\NativeMessagingHosts`），所以第 2 步选哪个浏览器都行，**不必为换浏览器重跑**。
2. **加载扩展**（在你想用的浏览器里做一次即可）：
   - **Edge**：打开 `edge://extensions` → 开启「开发人员模式」→「加载已解包的扩展」→ 选择 `extension/`
   - **Chrome**：打开 `chrome://extensions` → 开启「开发者模式」→「加载已解包的扩展」→ 选择 `extension/`
   - 随仓库分发的密钥对应扩展 ID `bjgdikingllkajknbjlopfmhgpcjponf`（**在 Edge 与 Chrome 下是同一个 ID**，因为扩展 ID 由 manifest 里的 `key` 推导，两个浏览器算法相同）；加载后**自动拉起 host 并监听默认 127.0.0.1:8090**。

完成上面两步后，**以后每次打开该浏览器就会自动可用**，无需重复操作。
如果浏览器提示 host 未连接，重跑第 1 步即可。

> **更新到新版本时请注意**：如果新包解压在**另一个目录**，必须重跑一次第 1 步（`install.bat`）。
> 注册表里存的是 manifest 的**绝对路径**，不重跑就仍然指向旧目录；旧目录一删，浏览器就报
> `Specified native messaging host not found`（跟 node、PATH 都无关）。直接覆盖同一个目录则不必。
> 详见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md#提示specified-native-messaging-host-not-found)。

## 浏览器兼容性：**Edge / Chrome 都支持**

它不是「Edge 专用」——凡是支持 MV3 扩展 + native messaging 的 Chromium 内核浏览器都能用：

| 浏览器 | 支持情况 |
|---|---|
| **Microsoft Edge** | ✅ 完整支持（默认示例） |
| **Google Chrome** | ✅ 完整支持，同一份 `extension/` 目录直接加载 |
| 其它 Chromium 内核（Brave、360、QQ 浏览器等） | 🟡 一般可用（需该浏览器支持「加载已解包的扩展」与用户级 native messaging 注册表键），未逐一实测 |

Chrome 用户请注意三点：

1. **换到 Chrome 不需要重跑安装脚本**——`install-host.ps1` 同时写了 Edge 和 Chrome 两处注册表键，直接加载扩展即可。
2. **Chrome 对「非应用商店来源」的扩展加固更严**：解包加载的扩展可能在 Chrome 更新或重启后被自动禁用（`chrome://extensions` 卡片变灰）。届时手动重新启用即可；想一劳永逸可加企业策略白名单（把扩展 ID 加入 `ExtensionInstallAllowlist`），或打包上架 Chrome 应用商店。
3. **不要同时在 Edge 和 Chrome 里都加载它**：两个浏览器会各拉起一个 host 进程争抢同一个 `127.0.0.1:8090`，只有一个能绑定成功（另一个不会崩，但会每 5 秒重试一次），且**请求最终由哪个浏览器执行是不确定的**。建议只用其一；确实需要两边都装时，给其中一个在插件「选项」里换个端口。

> 另外：**登录态不跨浏览器共享**。Chrome 用自己的 profile，需要访问的站点（如余额类接口）得在 Chrome 里重新登录一次。

## 配置监听地址 / 端口（在插件设置里改）

1. 在浏览器工具栏右键本扩展 → **「选项」**（或在 `edge://extensions` / `chrome://extensions` 里点本扩展的「扩展选项」）。
2. 填写「监听地址」与「监听端口」，点 **「保存并应用」**。
3. 扩展会自动重新加载，host 以新地址端口重启。验证：
   ```bash
   curl http://<你配置的地址>:<端口>/health
   ```

配置优先级（高 → 低）：**插件设置（chrome.storage）** > `host/config.json` > 环境变量 `WEBTOOPENAPI_HOST` / `WEBTOOPENAPI_PORT` > 内置默认 `127.0.0.1:8090`。
也就是说：在设置页填过，就以设置页为准；没填过则读 config.json。

> 想临时改也可编辑 `host/config.json` 或设环境变量，然后杀掉 host 进程，扩展会自动重拉。

## 页面打开策略：默认**不弹窗**

接口需要真实浏览器渲染，但**默认不会在你面前弹窗，也不会抢焦点**：它在当前窗口开一个后台标签，提取完立刻关掉，标签栏几乎看不到变化。

`host/config.json` 的 `page_mode` 控制这一行为（改完杀掉 host，扩展会自动重拉；也可以直接在**扩展设置页**的「浏览器行为」卡片里选，保存后立即生效、不用杀进程）：

| `page_mode` | 行为 | 适用 |
|---|---|---|
| `auto`（默认） | 按站点自选，目前等同于 `tab` | 大多数场景 |
| `tab` | **后台标签**：复用当前窗口，不新建窗口、不抢焦点，完成后自动关闭 | 平时使用 |
| `window` | 独立窗口但**不激活**（`focused:false`），完成后关标签、窗口随之消失 | 想在视觉上隔开 |
| `window-corner` | **右下角小窗口**（约 360×280 的 popup，不激活），只占角落 | 嫌 `window` 大窗挡屏幕时 |
| `window-front` | 独立窗口并**激活**（旧行为：每次调用都弹窗抢焦点） | 需要最快速度、可被打断时 |

也可以只临时改一次：`WEBTOOPENAPI_PAGE_MODE=auto|tab|window|window-corner|window-front` 环境变量。三种方式的优先级：**扩展设置页 > `config.json` > 环境变量**。

**`window-corner` 的实测结论（2026-10-20/21，本机 Edge）**：小窗落在右下角任务栏上方、`focused:false`、`state:normal`。屏幕大小由扩展用「最大化窗口尺寸 + 14px」推断（MV3 service worker 里没有 `window.screen`，Edge 也没有 `chrome.system.display`），推断值按 session 缓存。两种桌面下的表现：

- **浏览器窗口铺满屏幕**（最常见）：小窗被完全遮挡，页面 `visibilityState` 掉 `hidden`，但百度翻译端到端仍 3~5 秒（与未遮挡持平），定时器未观测到实质节流；用户视觉上完全无感。
- **浏览器窗口较小**：小窗在右下角可见约 `keep_tab_ms`（默认 3 分钟，供复用提速），不抢焦点，到期自动消失。

⚠️ **它不能提速**。分层实测（fresh = 不复用、每次全新开页面；稳态 = 标签复用中）：

| 场景 | fresh | 复用稳态 |
|---|---|---|
| 浏览器可见 | 3.1 / 3.5 / 3.6s | 2.7~3.6s |
| 浏览器最小化（hidden） | 3.3 / 4.4 / 4.5 / 6.9s | 2.8~3.2s |
| 最小化 + corner 独立窗 | 4.3 / 4.7s | — |

结论：`hidden` 只拖慢冷启动约 1.4s（百度 AI 生成 + 页面加载才是耗时大头，与可见性无关），标签一旦复用差异完全消失；corner 的独立窗不随主窗口最小化，但实测 fresh 4.3~4.7s 与 tab 的 hidden 4.8s 仍在噪声内，**没有可归因的速度收益**。选 `window-corner` 的唯一理由是"不想被 1280×900 大窗挡屏幕"。

⚠️ **关于"把浏览器放到 Hyper-V 虚机里保持始终可见"（更新于 2026-10-21）：技术上虚机内窗口状态完全独立于宿主机（VMConnect 最小化/宿主机锁屏都不影响），确实是唯一能在宿主机全后台时保位 `visible` 的方案。但**收益上限就是冷启动约 1s（hidden 4.8s → 可见 3.4s，方差很大），复用稳态零差异**；耄代是虚机常驻 2~4GB 内存 + 双份 host/扩展/网络链路，不值得。另注意：虚机内窗口被遮挡/最小化照样掉 `hidden`，虚机桌面最奿只开这一个窗口。

另一个实测发现（"最小化传染"）：**宿主机所有浏览器窗口都最小化时，新建窗口会以 `minimized` 状态创建**（`window-front` 的 `focused:true` 也抢不过这个机制，实测新窗口 `state=minimized`、页面 `hidden`）。因此 `window-front` 在"浏览器全后台"场景下无法保 `visible`，宿主机上没有任何模式能在全最小化时做到。

> **屏幕外窗口不可行**（已移除该模式）：`chrome.windows.create` 有「Bounds must be at least 50% within visible screen space」校验，直接拒绝 (20000,20000) 这类坐标；扩展用 `chrome.debugger` 附加的 tab 会话上没有 Browser 域，CDP `Browser.setWindowBounds` 也用不了（`-32601 wasn't found`）；把窗改 `minimized` 同样掉 `hidden`。早前「屏幕外窗口仍是 visible」的实测来自 playwright 的浏览器级 CDP 会话，扩展 API 够不到那个会话。

**一个必须知道的物理限制**：Chromium 会冻结"不可见"标签的渲染与网络。所以当**浏览器窗口被最小化或被完全遮挡**时，后台标签的页面会拖到 20~30 秒才开始加载，甚至超时。实测同一台机器、同一个谷歌查询：

| 浏览器窗口状态 | 打开方式 | 拿到结果 |
|---|---|---|
| 可见（哪怕没有焦点） | `tab` 后台标签 | **约 10 秒，8 条** |
| 最小化 / 被完全遮挡 | `tab` 后台标签 | 20 秒时页面仍是空白 |

超时时接口会返回 **504** 并说明原因（而不是安静地返回 0 条）：

```json
{
  "error": "google 页面没有渲染出任何内容: 浏览器窗口可能被最小化或完全遮挡, Chromium 会冻结不可见标签的加载",
  "hint": "把浏览器窗口切到前台(最小化恢复到屏幕可见即可, 不需要操作)后重试; 或在本机 host/config.json 设 page_mode=\"window-front\"...",
  "path": "/api/v1/search/google"
}
```

**需要人介入时会主动把页面切到前台**：遇到登录页、百度安全验证、谷歌 consent / 反爬验证时，接口会调用 `chrome_switch_tab` 把那个标签激活并聚焦窗口，保留页面不关闭，同时返回 **503 + `needs_human: true`**。你处理完再调一次即可。

> 同理，百度 / 翻译 / SCNet 这类轻页面在 `tab` 模式下几乎不受影响（实测 3~4 秒），只有谷歌这种重渲染页面敏感。

### 重复调用不再重新加载网页（`keep_tab_ms`）

「每次调用都新开标签、用完就关」有个隐藏代价：第 2、3 次调用仍然要**重新加载整站**。翻译接口实测，其中约 1.5 秒纯粹是页面加载。所以加了标签页复用：

| `keep_tab_ms` | 行为 |
|---|---|
| `180000`（默认，3 分钟） | 同一个站点连续调用时，保留标签页；这段时间内的调用**只改页面里的查询串**，不重载文档 |
| `0` | 关闭复用：每次调用结束就关标签页（旧行为，每次都重新加载） |

也可以临时改一次：`WEBTOOPENAPI_KEEP_TAB_MS=0` 环境变量。`/health` 会回显当前值。

**改这两个值最方便的地方是扩展设置页**：Edge / Chrome 工具栏 → 扩展图标 → 「扩展选项」（或 `edge://extensions` → 详细信息 → 扩展选项），里面的「浏览器行为」卡片可以直接选 `page_mode`、填 `keep_tab_ms`（单位秒），保存后立即下发到本地服务生效，不用重启浏览器、也不用改文件。设置页还会显示本地服务**当前实际生效的值**以及它是来自设置页覆盖还是 `config.json`，改完能当场确认。

覆盖优先级：**扩展设置页 > `host/config.json` > 环境变量 > 内置默认**。设置页里「恢复默认」会删掉覆盖、回到 `config.json` 的行为。覆盖值落盘在 `%LOCALAPPDATA%\webtoopenapi\service-config.json`，host 重启后仍生效。

实现上是三级降级，任何一级失败都只影响速度、不影响正确性：

1. **页内换参**（最快）：确认标签页还在目标站点 → `history.replaceState` 改查询串 + 派发 `popstate`，SPA 自己重新翻译；
2. 换参没生效（页面正忙 / 标签被用户关了 / 改作别用）→ 在这个标签页里**重载**目标 URL；
3. 重载也失败 → 新开一个标签页。

此外，**与上一次完全相同的请求**（同方向、同文本）会在 `keep_tab_ms` 窗口内直接返回上次结果，毫秒级、不碰浏览器。响应里 `reused: true` 表示复用了页面，`cached: true` 表示命中上次结果。

> 复用页面会带来一个必须防的坑：页面上还留着上一题的译文，只看「拿到了译文」会把**上一题的答案**当成本次结果返回（实测两段等长文本 `…test one.` / `…test two.` 就中招）。所以判定标准是：页面左栏的**源文本与本次请求一致**，且译文区被清空/替换过，才开始接受译文。

## 快速验证与调用示例

装好后先确认服务活着（三步就能看出问题在哪一层）：

```bash
curl http://127.0.0.1:8090/health                      # 服务 + 扩展连通状态
curl http://127.0.0.1:8090/api/v1/scnet/free-credit    # 示例：读一个需要登录的控制台
curl http://127.0.0.1:8090/docs                        # 浏览器打开，可视化试调
```

`/health` 打不通 → 看 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)；通了但参数不会用 → 看 [API.md](API.md)。

下面是最常用的三种调用，演示「网页能力 → HTTP 接口」的样子：

```bash
# 1) 搜索：中文必须走 POST（GET 查询串不允许未编码中文）
curl -s -X POST http://127.0.0.1:8090/api/v1/search/baidu \
  -H "Content-Type: application/json" \
  -d '{"q":"人工智能","site":["zhihu.com"],"rn":10,"time":"week"}'

# 2) 翻译：一个入口 + engine 切换，中文同样走 POST
curl -s -X POST http://127.0.0.1:8090/api/v1/translate \
  -H "Content-Type: application/json" \
  -d '{"q":"今天天气很好，我们去公园散步吧。","from":"zh","to":"en"}'

# 3) 临时抓一个页面，不必固化成端点（透传浏览器工具）
curl -s -X POST http://127.0.0.1:8090/api/v1/tools/chrome_navigate \
  -H "Content-Type: application/json" \
  -d '{"args":{"url":"https://www.baidu.com/s?wd=AI","newWindow":true}}'
```

> 完整的端点清单、每个参数的语义、返回字段、54 种语言代码、MCP 接入方式，都在 **[API.md](API.md)**；服务还自带 `GET /openapi.json`（OpenAPI 3.0，可直接导入 Postman / Apifox）与 `GET /docs`（在线试调页），文档与代码同源，不会过期。

## 扩展密钥（可选）

随仓库分发的 `extension/manifest.json` 里带一枚**固定公钥**，扩展 ID 因而固定为 `bjgdikingllkajknbjlopfmhgpcjponf`，开箱即用。

想换成自己的扩展 ID 时才需要以下步骤：

```bash
node tools/gen-key.mjs --apply   # 生成密钥 + 写回 manifest key 与 allowed_origins
```

然后双击 `host/install.bat` 重新注册，再在 `edge://extensions`（Chrome 则 `chrome://extensions`）里重新加载扩展。

> 私钥保存在 `host/extension-key.json`，已被 `.gitignore` 排除。**请勿提交或分发私钥**；`manifest.json` 里的只是公钥（与 Chrome 应用商店分发 CRX 时携带的公钥同类），不含密钥材料。

## 隐私与安全

- **只在本机**：默认监听 `127.0.0.1`，不对外暴露；不收集、不上传任何数据，也没有任何遥测。
- **无凭据存储**：服务不保存账号密码，也不持有任何 API Key —— 它复用的就是你在浏览器（Edge / Chrome）里已有的登录态（浏览器自动化 + 你自己的会话）。
- **接口无鉴权**：任何能访问 `127.0.0.1:8090` 的本机进程都能调用接口，等价于「能操控你的浏览器」。默认不要动监听地址 —— 真要让局域网/其他设备访问（扩展设置页的 Host 填 `0.0.0.0`，或改 `host/config.json`），请清楚代价：**同网段任何人都能打开任意网页、读走你能看到的任何登录态内容**。只在你信任的网络上这么用，用完改回 `127.0.0.1`。
  - 设置页的 Host 现在会真的生效（早期版本会静默忽略，只留一条 `ignoring override` 警告）：保存后扩展自动 reload，host 随之重新绑定。
  - 绑定 `0.0.0.0` 后，扩展自己的健康探测仍走 `127.0.0.1`（`0.0.0.0` 只是"监听所有网卡"，不能当目的地址用，Chromium 会直接拒绝），所以 popup 不会误报"服务未运行"。
  - 绑定成功后日志会打一条 `warn`：`listen host changed 127.0.0.1 -> 0.0.0.0: this API has NO authentication ...`，看到它就说明已经暴露在网络上。
- **用途合规**：请仅用于你本人有合法访问权限的账号与服务，遵守目标站点的使用条款与 robots 约定。

## 打包发布

本服务由「浏览器扩展（Edge / Chrome 通用）」+「本机 Node 原生宿主」两部分组成，二者需配套使用：

1. 把 `extension/` 整个目录压缩为 `web-to-openapi-extension.zip`，分发给使用者「加载已解包的扩展」；
2. 把 `host/`（含 `install-host.ps1`）一并分发；
3. 使用者执行一次 `install-host.ps1` 注册 native host + 加载扩展，即完成安装。

> **体积提示**：`extension/workers/` 里有 ONNX Runtime 的 WASM（约 32MB，上游语义相似度引擎用）。它们只服务于「按语义描述找页面元素」这类能力；本项目的 OpenAPI / MCP 端点（余额、搜索、页面抓取）不依赖它。不需要语义能力的话，删掉 `extension/workers/` 可把仓库从 ~45MB 降到 ~13MB，扩展照常工作。

## 新增一个网页（推荐方式）

站点采用**注册表架构**：一个网页 = `host/sites/` 下的一个文件。写好后在 `host/sites/index.js` 的清单里加一行 `require`，下面四处**自动生效**，不需要改动任何基础设施代码：

| 自动生效 | 说明 |
|---|---|
| REST 路由 | `endpoints[].path` + `methods`（`GET` / `POST`，POST 用于中文免 URL 编码） |
| MCP 工具 | `tools[]` 进入 `tools/list`，参数描述同时是 `/openapi.json` 与 `/docs` 的唯一数据源 |
| `/openapi.json` | `paths` 由 `endpoints` 派生 |
| `/docs` 文档页 | 卡片 + curl 示例由 `endpoints[].doc` 派生 |
| 扩展默认参数消息 | 有 `defaults` 的站点自动获得 `set/get_<id>_defaults` 消息（三层合并 + 落盘） |

站点模块最小形态：

```js
// host/sites/example.js
const { openPage, closeTab, jsEval } = require("../lib/util");
const { createDefaultsStore } = require("../lib/defaults");

const defaults = createDefaultsStore({
  id: "example", file: "example-defaults.json",
  builtin: { num: 20 },
  sanitize: (v) => (v && v.num ? { num: parseInt(v.num, 10) } : {}),
});

async function search(p) { /* openPage -> jsEval -> 结构化返回 */ }

module.exports = {
  id: "example",
  title: "示例站点",
  defaults,                                  // 可选
  endpoints: [{                              // REST
    method: "GET", methods: ["GET", "POST"], path: "/api/v1/search/example",
    tool: "example_search", operationId: "exampleSearch",
    summary: "…", description: "…", responses: { 200: { description: "…" } },
    parse: (input) => input,                 // GET 查询串 / POST JSON -> 参数对象
    run: (p) => search(p),
    browser: true,                           // 需要驱动浏览器 -> 自动串行化
    doc: { note: "…", tryQuery: "…", curlGet: "…", curlPost: "…" },
  }],
  tools: [{                                  // MCP
    name: "example_search", description: "…",
    inputSchema: { type: "object", properties: { q: { type: "string", description: "…" } } },
    browser: true, run: (args) => search(args),
  }],
};
```

> 摸清新站点的 DOM 结构可用 `tools/probe_baidu.py` 之类的 SERP 探针先采样。
> 临时用一次、不想固化成端点时，直接用透传接口 `POST /api/v1/tools/chrome_navigate` + `chrome_javascript`：
>
> ```bash
> curl -s -X POST http://127.0.0.1:8090/api/v1/tools/chrome_navigate \
>   -H "Content-Type: application/json" \
>   -d '{"args":{"url":"https://www.baidu.com/s?wd=AI","newWindow":true}}'
> curl -s -X POST http://127.0.0.1:8090/api/v1/tools/chrome_javascript \
>   -H "Content-Type: application/json" \
>   -d '{"args":{"tabId":123,"code":"return document.body.innerText"}}'
> ```

## 许可证与署名

本项目采用 [MIT 许可证](LICENSE)。

`extension/` 是在上游 **mcp-chrome-bridge**（npm 包名 `mcp-chrome-bridge`，浏览器插件版又称 chrome-mcp-server，MIT，© 2024 hangye）的基础上改造而来：保留其浏览器操作能力与 native messaging 协议，改造为「只提供 OpenAPI/MCP HTTP 服务、不提供 MCP 客户端连接」的桥接扩展，并替换为独立密钥与扩展 ID。上游许可条款见 [extension/LICENSE.upstream](extension/LICENSE.upstream)。
