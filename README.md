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

## 目录

| 路径 | 说明 |
|---|---|
| `extension/` | 独立浏览器扩展（**Edge / Chrome 通用**；从 `chrome-mcp-server-1.0.0` 复制改造：新密钥/新 ID、宿主名改为 `com.webtoopenapi.host`、品牌重命名为 Web To OpenAPI、内置 Options 设置页） |
| `host/openapi-host.js` | **启动入口（薄）**：装配站点注册表 → native messaging → HTTP 服务 |
| `host/lib/` | 基础设施：`config` 配置 / `log` 日志 / `nm` native messaging 命令通道 / `util` 浏览器操作（开页·执行 JS·重试提取·链接还原）/ `defaults` 默认参数三层合并 / `registry` 站点注册表 / `mcp` MCP 协议 / `spec` `/openapi.json` / `docs` `/docs` 文档页 / `tools` 浏览器工具目录 / `http` 路由分发 |
| `host/sites/` | **一个网页一个文件**：`scnet.js` / `baidu.js` / `google.js` / `translate.js`（在线翻译，内部用引擎表聚合多站点）+ 服务自身的 `_service.js`。新增能力只在这里加文件，见「新增一个网页」 |
| `host/mcp-stdio.js` | MCP stdio 桥接入口（独立进程，零依赖）：把 MCP 客户端的按行 JSON-RPC 转发到 `/mcp`，供 Claude Desktop 类客户端以 command 方式接入 |
| `host/config.json` | 监听地址/端口（`host` / `port` / `tool_timeout_ms`）、页面打开策略（`page_mode`）、标签页复用窗口（`keep_tab_ms`）。后两者可被「扩展设置页 → 浏览器行为」覆盖（优先级：设置页 > 本文件 > 环境变量 > 内置默认） |
| `host/run_host.bat` | 浏览器拉起 host 的启动器（自动找 node.exe；Edge / Chrome 走同一个） |
| `host/com.webtoopenapi.host.json` | native messaging manifest（`allowed_origins` = 扩展 ID，安装时自动推导，无需手改） |
| `host/install-host.ps1` | 注册/注销 native host（写 HKCU 注册表，无需管理员，Edge + Chrome 双键） |
| `tools/gen-key.mjs` | （可选）生成自己的扩展密钥 + 计算扩展 ID，可一键写回两处配置 |
| `tools/probe_baidu.py` | SERP 探针：新增搜索引擎时用它先摸清结果页 DOM 结构 |
| `tools/build-dist.py` | 打包发布 zip（产物不入库） |

## 部署（**只需一次**）

1. **注册 native host**（需要本机装了 Node.js；写入当前用户注册表，无需管理员）
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
| `window-front` | 独立窗口并**激活**（旧行为：每次调用都弹窗抢焦点） | 需要最快速度、可被打断时 |

也可以只临时改一次：`WEBTOOPENAPI_PAGE_MODE=tab|window|window-front|auto` 环境变量。三种方式的优先级：**扩展设置页 > `config.json` > 环境变量**。

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

## 验证

```bash
curl http://127.0.0.1:8090/health
curl http://127.0.0.1:8090/api/v1/scnet/free-credit   # 只查免费额度
curl http://127.0.0.1:8090/api/v1/scnet/token-plan     # 只查 Token Plan
curl http://127.0.0.1:8090/api/v1/scnet/balance        # 聚合: 两项一起查
```

## MCP 服务（与 REST 接口一一对应）

除 `http://127.0.0.1:8090` 的 REST 接口外，**同一进程同一端口**还提供 MCP 服务（Streamable HTTP transport，端点 `/mcp`），任何支持 MCP 的客户端可直接接入。工具与 REST 端点完全对应，中文查询词直接传（无 URL 编码问题）。

> **REST 还是 MCP？按场景选，不必二选一。** 两者底层是同一份实现：
>
> - **需求明确、要定时/批量/进流水线 → 用 REST**：确定性执行，可进 cron / CI，0 token，失败可重试，返回结构固定、程序直接消费；
> - **需求模糊、要让模型自己判断"该调什么、该搜什么词" → 用 MCP**：这时模型的推理开销是必要的。
>
> 反之，把已知流程也交给模型走 MCP，会额外付出「读工具清单 + 推理选参 + 试错重试」的成本，且是串行等待——**能确定做的事，别花钱让模型去猜。**

### 接入方式一：Streamable HTTP（url 方式）

```json
{
  "mcpServers": {
    "web-to-openapi": { "url": "http://127.0.0.1:8090/mcp" }
  }
}
```

### 接入方式二：stdio（command 方式，Claude Desktop 等）

```json
{
  "mcpServers": {
    "web-to-openapi": {
      "command": "node",
      "args": ["C:\\path\\to\\web-to-openapi\\host\\mcp-stdio.js"]
    }
  }
}
```

`mcp-stdio.js` 是零依赖桥接进程：把客户端按行发来的 JSON-RPC 转发给 `/mcp` 端点，响应原样写回 stdout。**前提：浏览器（Edge 或 Chrome）已启动且扩展在线**（openapi-host 由扩展自动拉起；上游不可达时桥接进程会在 stderr 给出明确提示，不会静默失败）。

### 工具清单

| 工具 | 对应 REST | 说明 |
|---|---|---|
| `scnet_free_credit` | `GET /api/v1/scnet/free-credit` | SCNet 免费额度（约 5-10s） |
| `scnet_token_plan` | `GET /api/v1/scnet/token-plan` | SCNet Token Plan（约 5-10s） |
| `scnet_balance` | `GET /api/v1/scnet/balance` | 免费额度 + Token Plan 聚合（约 10-20s） |
| `baidu_search` | `GET\|POST /api/v1/search/baidu` | 百度搜索，完整高级参数 |
| `google_search` | `GET\|POST /api/v1/search/google` | 谷歌搜索，完整高级参数 |
| `baidu_search_defaults` | `GET /api/v1/search/baidu/defaults` | 百度三层默认参数 |
| `google_search_defaults` | `GET /api/v1/search/google/defaults` | 谷歌三层默认参数 |
| `translate_text` | `GET\|POST /api/v1/translate` | 在线翻译，`engine` 切换引擎（当前百度） |
| `translate_engines` | `GET /api/v1/translate/engines` | 可用翻译引擎 + 54 种语言代码（含中文名与别名） |
| `service_health` | `GET /health` | 服务健康状态（监听/扩展连通/运行时长） |
| `browser_tool` | `POST /api/v1/tools/{name}` | 透传任意 chrome_* 浏览器工具 |

列表参数（site/intitle/inurl/intext/exclude/or）传数组（`["a.com","b.com"]`）或逗号分隔字符串均可；默认参数三层合并逻辑与 REST 完全一致（请求 > 设置页默认 > 内置）。

协议要点：JSON-RPC 2.0 over Streamable HTTP，支持 `initialize` / `tools/list` / `tools/call` / `ping`，notification 返回 202；带 Origin 头的浏览器请求须来自 localhost/127.0.0.1（防 DNS rebinding），curl/stdio 桥接不带头照常放行。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 存活探针（含扩展连接状态、运行时长、服务名 `web-to-openapi`） |
| GET | `/openapi.json` | OpenAPI 3.0 规范（可导入 Postman / Swagger UI） |
| GET | `/docs` | 文档页（可在线试调） |
| GET | `/api/v1/scnet/free-credit` | **示例接口**：SCNet 免费额度（实时驱动浏览器（Edge / Chrome）打开控制台提取，约 5-10s） |
| GET | `/api/v1/scnet/token-plan` | **示例接口**：SCNet Token Plan（实时驱动浏览器（Edge / Chrome）打开控制台提取，约 5-10s） |
| GET | `/api/v1/scnet/balance` | 聚合接口：免费额度 + Token Plan 一次返回（约 10-20s） |
| GET | `/api/v1/search/baidu` | **百度搜索**：完整高级查询参数（见下文），实时驱动浏览器（Edge / Chrome）打开百度解析结果（约 5-15s） |
| POST | `/api/v1/search/baidu` | 同上，JSON body 传参——**中文查询词必须用这个**（GET 查询串不允许未编码中文，会 400） |
| GET | `/api/v1/search/baidu/defaults` | 查看百度搜索默认参数（内置 / 扩展设置页下发 / 最终生效） |
| GET | `/api/v1/search/google` | **谷歌搜索**：完整高级查询参数（见下文），实时驱动浏览器（Edge / Chrome）打开谷歌解析结果（约 5-15s） |
| POST | `/api/v1/search/google` | 同上，JSON body 传参——**中文查询词必须用这个**（GET 查询串不允许未编码中文，会 400） |
| GET | `/api/v1/search/google/defaults` | 查看谷歌搜索默认参数（内置 / 扩展设置页下发 / 最终生效） |
| GET | `/api/v1/translate` | **在线翻译**：`q` + `from`/`to` + `engine`（统一入口，当前支持百度），首次约 3-5s，之后再调约 2s（复用页面）。`from`/`to` 可选 54 种语言代码，见下文清单 |
| POST | `/api/v1/translate` | 同上，JSON body 传参——**中文文本推荐用这个** |
| GET | `/api/v1/translate/engines` | 可用翻译引擎 + 54 种语言代码（`languages[].code/label/aliases`） |
| GET | `/api/v1/tools` | 可用浏览器操作工具目录 |
| POST | `/api/v1/tools/{name}` | 透传调用任意浏览器工具（搜索、抓取等新能力的统一入口） |

> 示例接口 `scnet/free-credit`、`scnet/token-plan`、`search/baidu`、`search/google` 只是「用浏览器能力封装一个 Web API」的样板。新增任何 Web 能力（如页面正文提取、表单自动化）都走同一套机制，成熟后会作为预置端点陆续加入。

### 百度搜索：完整高级查询参数

> **中文查询词请用 POST**：HTTP 协议规定请求行只允许 ASCII。`?q=人工智能` 不编码会被 Node 的 HTTP 解析器在协议层直接打回 `400 Bad Request`（空响应体，路由代码都进不去）。两种做法：① GET 参数做 URL 编码（`?q=%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD`）；② **推荐** POST JSON body，中文零编码：
>
> ```bash
> curl -s -X POST http://127.0.0.1:8090/api/v1/search/baidu \
>   -H "Content-Type: application/json" \
>   -d '{"q":"人工智能","site":["zhihu.com"],"rn":10,"time":"week"}'
> ```
>
> POST 与 GET 参数完全同构；列表参数直接传数组（`site:["a.com","b.com"]`），无需重复键名。

```bash
# 基础 + 高级操作符(可直接写在 q 里)
curl -s "http://127.0.0.1:8090/api/v1/search/baidu?q=transformer%20site:github.com%20intitle:attention%20filetype:pdf%20-广告"

# 结构化参数(等价效果, 站点/排除词可重复或逗号分隔)
curl -s "http://127.0.0.1:8090/api/v1/search/baidu?q=transformer&site=github.com,python.org&intitle=attention&filetype=pdf&exclude=广告,招聘&exact=attention%20is%20all%20you%20need"

# 分页 / 时间范围 / 解析真实 URL
curl -s "http://127.0.0.1:8090/api/v1/search/baidu?q=AI&rn=20&page=2&time=week&resolve_urls=true"
```

| 参数 | 说明 |
|---|---|
| `q` | 基础查询词，可含高级操作符：`site:` `intitle:` `inurl:` `filetype:` `-排除词` `"精确短语"` |
| `site` | 限定站点（可重复 `&site=a&site=b` 或逗号分隔）→ `site:xxx` |
| `intitle` | 标题必须包含 → `intitle:xxx` |
| `inurl` | URL 必须包含 → `inurl:xxx` |
| `filetype` | 文件类型：`pdf` / `doc` / `xls` / `ppt` / `rtf` |
| `exact` | 精确短语 → `"xxx"` |
| `exclude` | 排除词（可重复/逗号分隔）→ `-xxx` |
| `rn` | 每页条数：`10` / `20` / `30` / `40` / `50` / `100` |
| `page` | 页码（1 起，内部换算 `pn` 偏移） |
| `time` | 时间范围：`day` / `week` / `month` / `year`（内部换算百度 `gpc` 时间过滤参数） |
| `resolve_urls` | `true` 时把百度跳转链接解析为真实 URL（302，约 90ms/条，并发 8；失败保留原链接） |

返回字段：`query`（最终生效的查询词）/ `page` / `rn` / `time` / `total`（百度找到的相关结果数，best-effort）/ `count` / `items[]`，每项含 `title` / `url`（百度跳转链接）/ `real_url`（resolve_urls=true 时）/ `abstract` / `date`（如「2024年3月22日」「3天前」）/ `is_ad`（是否推广）。

### 谷歌搜索：完整高级查询参数

> **中文查询词请用 POST**（同百度）：`?q=人工智能` 不编码会被 HTTP 协议层直接打回 `400 Bad Request`。
>
> ```bash
> curl -s -X POST http://127.0.0.1:8090/api/v1/search/google \
>   -H "Content-Type: application/json" \
>   -d '{"q":"人工智能","site":["github.com"],"num":10,"time":"week"}'
> ```

```bash
# 基础 + 高级操作符(可直接写在 q 里)
curl -s "http://127.0.0.1:8090/api/v1/search/google?q=transformer%20site:github.com%20intitle:attention%20filetype:pdf%20-广告"

# 结构化参数(等价效果, 站点/排除词/或关键词可重复或逗号分隔)
curl -s "http://127.0.0.1:8090/api/v1/search/google?q=transformer&site=github.com,python.org&intitle=attention&or=BERT,GPT&exclude=ads&exact=attention%20is%20all%20you%20need"

# 分页 / 时间范围 / 自定义日期区间 / 解析真实 URL
curl -s "http://127.0.0.1:8090/api/v1/search/google?q=AI&num=20&page=2&time=week&resolve_urls=true"
curl -s "http://127.0.0.1:8090/api/v1/search/google?q=AI&after=2026-01-01&before=2026-06-30"

# 语言/地区/安全搜索/垂直搜索/关闭纠错/逐字匹配
curl -s "http://127.0.0.1:8090/api/v1/search/google?q=人工智能&hl=zh-CN&gl=cn&lr=lang_zh-CN&safe=off&nfpr=true&verbatim=true"
curl -s "http://127.0.0.1:8090/api/v1/search/google?q=AI&tbm=nws"   # 新闻垂直
```

| 参数 | 说明 |
|---|---|
| `q` | 基础查询词，可含高级操作符：`site:` `intitle:` `inurl:` `intext:` `filetype:` `link:` `-排除词` `"精确短语"` `OR` |
| `site` | 限定站点（可重复 `&site=a&site=b` 或逗号分隔）→ `site:xxx` |
| `intitle` | 标题必须包含 → `intitle:xxx` |
| `inurl` | URL 必须包含 → `inurl:xxx` |
| `intext` | 正文必须包含 → `intext:xxx` |
| `filetype` | 文件类型：`pdf` / `doc` / `docx` / `xls` / `xlsx` / `ppt` / `pptx` / `txt` / `rtf` |
| `exact` | 精确短语 → `"xxx"` |
| `exclude` | 排除词（可重复/逗号分隔）→ `-xxx` |
| `or` | 或关键词（可重复/逗号分隔）→ `(a OR b)` |
| `link` | 链接到某 URL 的网页 → `link:xxx` |
| `num` | 每页条数：`10` / `20` / `30` / `50` / `100` |
| `page` | 页码（1 起，内部换算 `start` 偏移） |
| `start` | 起始偏移（显式提供时**覆盖** page） |
| `time` | 时间范围：`hour` / `day` / `week` / `month` / `year`（内部换算谷歌 `tbs=qdr:h/d/w/m/y`） |
| `after` / `before` | 自定义日期区间 `YYYY-MM-DD`（内部换算 `tbs=cdr:1,cd_min:M/D/YYYY,cd_max:...`） |
| `hl` | 界面语言（默认 `zh-CN`，如 `en`） |
| `gl` | 国家/地区代码（如 `cn` / `us` / `jp`） |
| `lr` | 限定语言（如 `lang_zh-CN`） |
| `cr` | 限定国家（如 `countryCN`） |
| `safe` | 安全搜索：`off` / `active` |
| `tbm` | 垂直搜索：空=网页 / `nws`=新闻 / `isch`=图片 / `vid`=视频（结构化提取以网页/新闻为准） |
| `nfpr` | `true` 关闭拼写纠错（`nfpr=1`） |
| `verbatim` | `true` 逐字匹配，不做同义词扩展（`tbs=li:1`） |
| `resolve_urls` | `true` 时把 `/url?q=` 与 `/aclk?url=` 等谷歌跳转链接解析为真实 URL（先本地解参数，再 302 兜底；并发 8，失败保留原链接） |

返回字段：`query`（最终生效的查询词）/ `page` / `num` / `start` / `time` / `after` / `before` / `total`（谷歌结果数，best-effort）/ `count` / `page_loaded`（SERP 是否完整加载）/ `no_result`（true = 谷歌明确返回零结果页，与「页面没加载完」区分）/ `items[]`，每项含 `title` / `url` / `real_url`（resolve_urls=true 时）/ `abstract` / `date`（如「2024年3月22日」「Jan 1, 2024」「3天前」）/ `is_ad`（是否推广）。

> 注意：谷歌在部分网络环境下会返回 consent 同意页或反爬验证页（`/sorry/`），此时接口返回明确错误提示，按提示在浏览器（Edge / Chrome）里手动完成一次搜索/验证后重试即可。

### 在线翻译：统一入口 + 引擎表

翻译没有做成「一个站点一个端点」，而是**一个入口 + `engine` 参数**——调用方不用记多个路径，加引擎也不影响已有调用：

```bash
# GET（英文/短文本）
curl -s "http://127.0.0.1:8090/api/v1/translate?q=hello%20world&from=en&to=zh"

# POST（中文推荐：body 里的中文不用 URL 编码）
curl -s -X POST http://127.0.0.1:8090/api/v1/translate \
  -H "Content-Type: application/json" \
  -d '{"q":"今天天气很好，我们去公园散步吧。","from":"zh","to":"en","engine":"baidu"}'

# 查看可用引擎与语言代码
curl -s http://127.0.0.1:8090/api/v1/translate/engines
```

参数：`q`（必填，上限 5000 字符）· `from`（默认 `auto`，`auto` 只在 `from` 可用）· `to`（默认 `zh`）· `engine`（默认 `baidu`）· `detail`（是否附带词典/例句，默认 `true`）。

#### `from` / `to` 的语言代码（54 种）

每个代码都在百度翻译网页版实测出过对应语种的译文（2026-10），下面括号里是同样接受的 ISO 别名：

- **中文系**：`zh` 中文简体（`zh-CN` / `chs` / `cn`）· `cht` 中文繁体（`zh-TW` / `zh-HK`）· `yue` 粤语 · `wyw` 文言文
- **常用语种**：`en` 英语 · `jp` 日语（`ja`）· `kor` 韩语（`ko`）· `fra` 法语（`fr`）· `spa` 西班牙语（`es`）· `de` 德语 · `ru` 俄语 · `it` 意大利语 · `pt` 葡萄牙语 · `ara` 阿拉伯语（`ar`）· `th` 泰语 · `vie` 越南语（`vi`）· `nl` 荷兰语 · `pl` 波兰语 · `tr` 土耳其语
- **欧洲其他**：`el` 希腊语 · `fin` 芬兰语（`fi`）· `dan` 丹麦语（`da`）· `swe` 瑞典语（`sv`）· `cs` 捷克语 · `hu` 匈牙利语 · `rom` 罗马尼亚语（`ro`）· `bul` 保加利亚语（`bg`）· `ukr` 乌克兰语（`uk`）· `srp` 塞尔维亚语（`sr`）· `hrv` 克罗地亚语（`hr`）· `sk` 斯洛伐克语 · `slo` 斯洛文尼亚语（`sl`）· `lit` 立陶宛语（`lt`）· `lav` 拉脱维亚语（`lv`）· `est` 爱沙尼亚语（`et`）· `nor` 挪威语（`no`）· `ice` 冰岛语（`is`）· `geo` 格鲁吉亚语（`ka`）· `arm` 亚美尼亚语（`hy`）· `aze` 阿塞拜疆语（`az`）
- **亚洲其他**：`heb` 希伯来语（`he`）· `hi` 印地语 · `id` 印尼语 · `may` 马来语（`ms`）· `bur` 缅甸语（`my`）· `fil` 菲律宾语（`tl`）· `lao` 老挝语（`lo`）· `nep` 尼泊尔语（`ne`）· `urd` 乌尔都语（`ur`）· `per` 波斯语（`fa`）· `tam` 泰米尔语（`ta`）· `tel` 泰卢固语（`te`）· `mal` 马拉雅拉姆语（`ml`）· `ben` 孟加拉语（`bn`）

机器可读的完整清单（含每项的 `label` 与 `aliases`）：`GET /api/v1/translate/engines` 的 `languages` 字段，文档页 `/docs` 也有同源折叠表格。

> **未收录的代码直接返回 `400`，不做透传。** 原因是实测发现百度对不认识的目标语言**不报错，而是静默回退成中文**——`to=uk` / `tl` / `km` / `lo` / `ne` / `ur` / `fa` / `mong` / `kaz` / `uzb` 全部返回 `200`，但 `to_label` 变成「中文(简体)」、译文是中文。静默给错语种比报错危险得多（调用方会以为翻译成功了），所以这里宁可 400。其中 `uk` / `tl` / `lo` / `ne` / `ur` / `fa` 这类 ISO 简写已映射到正确代码，`km`（高棉语）、`mong`、`kaz`、`uzb` 网页版确实不支持。
>
> 另有一层运行时兜底：返回时会核对页面实际识别的目标语言，若与请求的代码不符，响应里会多出 `"to_label_mismatch": true`（正常情况下不会出现）。

返回：`translation`（整段译文）· `segments`（按段落/行拆分，多段文本有用）· `from` / `to`（归一化后的代码，`zh-TW` 会回显为 `cht`）· `from_label` / `to_label`（页面实际识别的语言，可用来核对方向）· `dict`（重点词汇 `[{word, defs}]`）· `details_text`（词典与例句原文，best-effort）· `reused`（本次是否复用了已打开的页面）· `cached`（是否命中上一次相同请求的结果）· `elapsed_ms`。

实测（2026-10，百度翻译）：英→中、中→英、`auto` 自动检测、多段文本、`detail=false`、ISO 别名（`ja` / `ko` / `fr` / `es` / `zh-TW`）均通过；54 种语言逐一跑过「Hello, good morning.」→ 目标语，全部返回对应语种译文。页面结构要点：译文容器是稳定 id `#trans-selection`（不是混淆类名），所以比搜索类站点抗改版。

**速度**（同一台机器、连续调用实测）：

| 场景 | 耗时 | 说明 |
|---|---|---|
| 首次调用 | **3.5-5.2 秒** | 要加载百度翻译整站（JS / CSS / 首屏） |
| `keep_tab_ms` 内的后续调用 | **2.0-2.8 秒** | 只改页面里的查询串，不重载文档（`reused: true`） |
| 与上一次完全相同的请求 | **4-5 毫秒** | 直接返回上次结果（`cached: true`） |

省下来的基本就是页面加载那 1.5 秒；剩下的 2 秒是百度 AI 翻译自己的生成时间（流式输出，实测首字 ~1.8 秒、结束 ~2.3 秒），换机换网都在这个量级。顺带测过页面上的「机翻 · 通用领域」档位，只比 AI 档快 0.4 秒，不值得为它增加一套切换逻辑。

**为什么只接了百度**：翻译站的官方 API 普遍按字符计费，而免费网页版基本不限量，这才是「把网页变成 API」的收益所在。百度网页版免登录、URL 带参直达、DOM 结构清楚，是投入产出比最高的一个。其它站点实测结论：Google 翻译页面在国内网络下加载不出来（但它的免费 HTTP 端点可直连，不需要浏览器）；DeepL 页面能开，但 `#en/zh/文本` 带参已失效，需要注入文本 + 先切目标语言；Reverso / Linguee 有 Cloudflare 人机验证，自动化不可用；火山翻译官网已 404。

**加一个引擎**：在 `host/sites/translate.js` 的 `ENGINES` 里加一项（`buildUrl` + `translate`），路由 / MCP 工具 / `openapi.json` / 文档页全部自动沿用。需要「注入文本 + 点按钮」的引擎，用 `chrome_fill_or_select` / `chrome_click_element` 组合即可，结构不用改。

### 在插件设置页配置默认查询参数

扩展设置页（`edge://extensions` 或 `chrome://extensions` → 本扩展「详细信息」→「扩展选项」）提供「百度搜索默认参数」与「Google 搜索默认参数」两张卡片：
默认站点 / 标题含 / URL 含 / 正文含（Google）/ 排除词 / 精确短语 / 或关键词（Google）/ 链接页（Google）/ 文件类型 / 每页条数 / 时间范围 / 安全搜索、界面语言、国家地区、限定语言/国家、垂直搜索、起止日期（Google）/ 是否解析真实 URL / 关闭纠错、逐字匹配（Google）。

- 分别保存在扩展存储（`webtoopenapi_baidu_defaults` / `webtoopenapi_google_defaults`），经 native messaging 下发给 host 并持久化到 `%LOCALAPPDATA%\webtoopenapi\baidu-defaults.json` / `google-defaults.json`（host 重启不丢失，扩展重连也会自动同步）。
- **合并顺序：请求显式参数 > 设置页默认 > 内置默认**（百度内置 `rn=50, page=1, 不限时间, 不解析`；谷歌内置 `num=20, page=1, hl=zh-CN, 不限时间, 不解析`）。列表类参数（site/intitle/inurl/exclude/or）请求出现时**整体替换**默认，不叠加。
- `GET /api/v1/search/baidu/defaults`、`GET /api/v1/search/google/defaults` 可随时查看三层默认值。

免费额度返回示例（`/api/v1/scnet/free-credit`）：

```json
{
  "source": "scnet console via web-to-openapi",
  "fetched_at": "2026-10-16T14:32:19.702Z",
  "free_credit": { "remaining": 9999916, "total": 10000000, "used": 84, "remaining_percent": 100, "model": "GLM-5.3-Flash", "days_left": 28 }
}
```

Token Plan 返回示例（`/api/v1/scnet/token-plan`）：

```json
{
  "source": "scnet console via web-to-openapi",
  "fetched_at": "2026-10-16T14:32:19.702Z",
  "token_plan": { "plan_monthly_credits": 30000, "total_credits": 30000, "remaining_credits": 26083.2, "remaining_percent": 87, "used_credits": 3916.8, "used_percent": 13, "days_left": 30 }
}
```

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
- **接口无鉴权**：任何能访问 `127.0.0.1:8090` 的本机进程都能调用接口，等价于「能操控你的浏览器」。**不要把它绑定到 `0.0.0.0` 或暴露到公网/局域网**。
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

## 运维说明

- **生命周期**：host 由浏览器扩展拉起；浏览器退出 → host 退出 → HTTP 不可用（浏览器自动化的固有属性，与 chrome-mcp-server 一致）。
- **日志**：`%LOCALAPPDATA%\webtoopenapi\logs\openapi-host.log`（协议走 stdout，日志只走 stderr + 文件）。
- **升级风险**：本服务不修改任何第三方包；`extension/` 是独立副本，原扩展与 bridge 升级都不受影响。
- **已知限制**：依赖下载/文件保存类的工具（`file_operation`）未实现，会明确报错；`chrome_screenshot` 仅存档（当前模型读不了图）。
- **前提**：浏览器（Edge / Chrome）已加载本扩展；调用具体站点接口（如余额）还需该站点已登录。

## 常见问题

**Q：接口返回 400 Bad Request，响应体是空的？**
GET 查询串里带了未编码的中文（`?q=人工智能`）。HTTP 请求行只允许 ASCII，Node 的解析器会在协议层直接拒绝。改用 POST + JSON body（中文零编码），或对参数做 URL 编码。

**Q：浏览器提示 host 未连接？**
重跑一次 `host/install.bat`（脚本会自愈路径与扩展 ID），然后在 `edge://extensions`（Chrome 则 `chrome://extensions`）里重新加载扩展。

**Q：能不能在 Chrome 上用？我只看到文档里写 Edge。**
能，Edge 只是文档里的默认示例。同一份 `extension/` 目录在 Chrome 的 `chrome://extensions` 里直接加载即可，安装脚本已经把 Chrome 的注册键一起写好了；扩展 ID 也是同一个。详见「浏览器兼容性」一节。

**Q：Edge 和 Chrome 同时装会怎样？**
两者会争抢同一个端口，只有一个 host 能绑定成功，请求由哪个浏览器执行变得不确定。建议只在一边加载，或给其中一个换端口。

**Q：搜索接口返回 0 条？**
先看返回里的 `page_loaded` 与 `no_result`：`no_result: true` 表示搜索引擎确实返回了零结果页（不是失败）；两者都为 false 则可能是页面没加载完或触发了验证页，在浏览器里手动访问一次该站点再重试。

**Q：每次调用都会弹出浏览器窗口吗？**
不会。默认 `page_mode=auto`（等同 `tab`）会在当前窗口开一个**后台标签**，不新建窗口、不抢焦点，提取完立即关闭。只有在遇到登录/验证码时，才会主动把那个标签切到前台让你处理。想彻底避免任何视觉变化就保持 `tab`；想更快可以设 `window-front`，代价是每次都会弹窗。

**Q：为什么要 20 秒，明明浏览器里一两秒就出结果？**
因为浏览器窗口被最小化或被别的窗口完全遮挡时，Chromium 会冻结不可见标签的渲染与网络。把浏览器窗口露出来（不需要操作）就会回到正常速度。这是浏览器行为，任何扩展方案都绕不过去。

## 许可证与署名

本项目采用 [MIT 许可证](LICENSE)。

`extension/` 是在上游 **mcp-chrome-bridge**（npm 包名 `mcp-chrome-bridge`，浏览器插件版又称 chrome-mcp-server，MIT，© 2024 hangye）的基础上改造而来：保留其浏览器操作能力与 native messaging 协议，改造为「只提供 OpenAPI/MCP HTTP 服务、不提供 MCP 客户端连接」的桥接扩展，并替换为独立密钥与扩展 ID。上游许可条款见 [extension/LICENSE.upstream](extension/LICENSE.upstream)。
