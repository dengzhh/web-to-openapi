# Web To OpenAPI —— 把任意网页能力封装成 OpenAPI / MCP 的 Edge 插件 + 本地服务

把浏览器里的任意网页能力（需要登录的控制台、搜索引擎结果页、动态渲染的页面……），包装成**本地 HTTP 服务**对外提供：一套代码，**同时**暴露 OpenAPI（REST）与 MCP 两套接口。

- **两套接口，同一进程同一端口**：REST 供 `curl` / 任何语言调用；`/mcp` 端点供 MCP 客户端直接接入（也可用 `mcp-stdio.js` 以 command 方式接入）；
- **不依赖任何浏览器驱动**：走 Edge 扩展 + native messaging，用的是**你在浏览器里已有的登录态**，不需要再处理 Cookie / 验证码 / 2FA；
- **底层复用 chrome-mcp-server（mcp-chrome-bridge）的浏览器操作接口**：native messaging `CALL_TOOL` → 扩展执行 `chrome_navigate` / `chrome_javascript` / `chrome_read_page` 等内置工具（协议与 mcp-chrome-bridge 同源）；
- **监听地址 / 端口可在「插件设置」里配置**：通过扩展 Options 页写入，保存后自动生效，**无需手改任何文件**；
- **全部跑在本机**：默认只监听 `127.0.0.1`，不对外暴露，不上传任何数据。

> **适用边界**：它解决的是「没有公开 API、但又想用程序拿到数据」这类场景——**前提是你本人在浏览器里对该站点有合法访问权限**。请仅用于你有权限访问的账号与服务，并遵守目标站点的使用条款。

> 一句话：**安装一次，之后每次开 Edge 自动可用**；地址和端口在插件设置里改，不用碰命令行。

## 架构

```
HTTP 客户端 (curl / 你的代码 / 其他服务)
      │  GET /api/v1/scnet/balance ...  (示例接口; 更多 Web API 陆续加入)
      ▼
openapi-host.js ── lib/(基础设施) ── sites/(一个网页一个文件)
  (Node, 地址/端口由「插件设置」决定, 默认 127.0.0.1:8090)
      │  native messaging(stdio): {type:"call_tool", payload:{name,args}, requestId}
      ▼
Edge 扩展(web-to-openapi/extension, 独立副本, 不提供 MCP)
      │  chrome.tabs / chrome.scripting / chrome.debugger ...
      ▼
真实 Edge 浏览器(已登录对应网站的登录态)
```

## 目录

| 路径 | 说明 |
|---|---|
| `extension/` | 独立 Edge 扩展（从 `chrome-mcp-server-1.0.0` 复制改造：新密钥/新 ID、宿主名改为 `com.webtoopenapi.host`、品牌重命名为 Web To OpenAPI、内置 Options 设置页） |
| `host/openapi-host.js` | **启动入口（薄）**：装配站点注册表 → native messaging → HTTP 服务 |
| `host/lib/` | 基础设施：`config` 配置 / `log` 日志 / `nm` native messaging 命令通道 / `util` 浏览器操作（开页·执行 JS·重试提取·链接还原）/ `defaults` 默认参数三层合并 / `registry` 站点注册表 / `mcp` MCP 协议 / `spec` `/openapi.json` / `docs` `/docs` 文档页 / `tools` 浏览器工具目录 / `http` 路由分发 |
| `host/sites/` | **一个网页一个文件**：`scnet.js` / `baidu.js` / `google.js`（以及服务自身的 `_service.js`）。新增能力只在这里加文件，见「新增一个网页」 |
| `host/mcp-stdio.js` | MCP stdio 桥接入口（独立进程，零依赖）：把 MCP 客户端的按行 JSON-RPC 转发到 `/mcp`，供 Claude Desktop 类客户端以 command 方式接入 |
| `host/config.json` | **默认**监听地址/端口（`host` / `port` / `tool_timeout_ms`）——仅当「插件设置」未配置时生效 |
| `host/run_host.bat` | Edge 拉起 host 的启动器（自动找 node.exe） |
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
2. **加载扩展**：Edge 打开 `edge://extensions` → 开启「开发人员模式」→「加载已解包的扩展」→ 选择
   `extension/`
   （随仓库分发的密钥对应扩展 ID `bjgdikingllkajknbjlopfmhgpcjponf`；加载后**自动拉起 host 并监听默认 127.0.0.1:8090**）

完成上面两步后，**以后每次打开 Edge 就会自动可用**，无需重复操作。
如果 Edge 提示 host 未连接，重跑第 1 步即可。

## 配置监听地址 / 端口（在插件设置里改）

1. 在 Edge 工具栏右键本扩展 → **「选项」**（或在 `edge://extensions` 里点本扩展的「扩展选项」）。
2. 填写「监听地址」与「监听端口」，点 **「保存并应用」**。
3. 扩展会自动重新加载，host 以新地址端口重启。验证：
   ```bash
   curl http://<你配置的地址>:<端口>/health
   ```

配置优先级（高 → 低）：**插件设置（chrome.storage）** > `host/config.json` > 环境变量 `WEBTOOPENAPI_HOST` / `WEBTOOPENAPI_PORT` > 内置默认 `127.0.0.1:8090`。
也就是说：在设置页填过，就以设置页为准；没填过则读 config.json。

> 想临时改也可编辑 `host/config.json` 或设环境变量，然后杀掉 host 进程，扩展会自动重拉。

## 验证

```bash
curl http://127.0.0.1:8090/health
curl http://127.0.0.1:8090/api/v1/scnet/free-credit   # 只查免费额度
curl http://127.0.0.1:8090/api/v1/scnet/token-plan     # 只查 Token Plan
curl http://127.0.0.1:8090/api/v1/scnet/balance        # 聚合: 两项一起查
```

## MCP 服务（与 REST 接口一一对应）

除 `http://127.0.0.1:8090` 的 REST 接口外，**同一进程同一端口**还提供 MCP 服务（Streamable HTTP transport，端点 `/mcp`），任何支持 MCP 的客户端可直接接入。工具与 REST 端点完全对应，中文查询词直接传（无 URL 编码问题）。

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

`mcp-stdio.js` 是零依赖桥接进程：把客户端按行发来的 JSON-RPC 转发给 `/mcp` 端点，响应原样写回 stdout。**前提：Edge 已启动且扩展在线**（openapi-host 由扩展自动拉起；上游不可达时桥接进程会在 stderr 给出明确提示，不会静默失败）。

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
| GET | `/api/v1/scnet/free-credit` | **示例接口**：SCNet 免费额度（实时驱动 Edge 打开控制台提取，约 5-10s） |
| GET | `/api/v1/scnet/token-plan` | **示例接口**：SCNet Token Plan（实时驱动 Edge 打开控制台提取，约 5-10s） |
| GET | `/api/v1/scnet/balance` | 聚合接口：免费额度 + Token Plan 一次返回（约 10-20s） |
| GET | `/api/v1/search/baidu` | **百度搜索**：完整高级查询参数（见下文），实时驱动 Edge 打开百度解析结果（约 5-15s） |
| POST | `/api/v1/search/baidu` | 同上，JSON body 传参——**中文查询词必须用这个**（GET 查询串不允许未编码中文，会 400） |
| GET | `/api/v1/search/baidu/defaults` | 查看百度搜索默认参数（内置 / 扩展设置页下发 / 最终生效） |
| GET | `/api/v1/search/google` | **谷歌搜索**：完整高级查询参数（见下文），实时驱动 Edge 打开谷歌解析结果（约 5-15s） |
| POST | `/api/v1/search/google` | 同上，JSON body 传参——**中文查询词必须用这个**（GET 查询串不允许未编码中文，会 400） |
| GET | `/api/v1/search/google/defaults` | 查看谷歌搜索默认参数（内置 / 扩展设置页下发 / 最终生效） |
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

> 注意：谷歌在部分网络环境下会返回 consent 同意页或反爬验证页（`/sorry/`），此时接口返回明确错误提示，按提示在 Edge 里手动完成一次搜索/验证后重试即可。

### 在插件设置页配置默认查询参数

扩展设置页（`edge://extensions` → 本扩展「详细信息」→「扩展选项」）提供「百度搜索默认参数」与「Google 搜索默认参数」两张卡片：
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

然后双击 `host/install.bat` 重新注册，再在 `edge://extensions` 里重新加载扩展。

> 私钥保存在 `host/extension-key.json`，已被 `.gitignore` 排除。**请勿提交或分发私钥**；`manifest.json` 里的只是公钥（与 Chrome 应用商店分发 CRX 时携带的公钥同类），不含密钥材料。

## 隐私与安全

- **只在本机**：默认监听 `127.0.0.1`，不对外暴露；不收集、不上传任何数据，也没有任何遥测。
- **无凭据存储**：服务不保存账号密码，也不持有任何 API Key —— 它复用的就是你在 Edge 里已有的登录态（浏览器自动化 + 你自己的会话）。
- **接口无鉴权**：任何能访问 `127.0.0.1:8090` 的本机进程都能调用接口，等价于「能操控你的浏览器」。**不要把它绑定到 `0.0.0.0` 或暴露到公网/局域网**。
- **用途合规**：请仅用于你本人有合法访问权限的账号与服务，遵守目标站点的使用条款与 robots 约定。

## 打包发布

本服务由「Edge 扩展」+「本机 Node 原生宿主」两部分组成，二者需配套使用：

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

- **生命周期**：host 由 Edge 扩展拉起；Edge 退出 → host 退出 → HTTP 不可用（浏览器自动化的固有属性，与 chrome-mcp-server 一致）。
- **日志**：`%LOCALAPPDATA%\webtoopenapi\logs\openapi-host.log`（协议走 stdout，日志只走 stderr + 文件）。
- **升级风险**：本服务不修改任何第三方包；`extension/` 是独立副本，原扩展与 bridge 升级都不受影响。
- **已知限制**：依赖下载/文件保存类的工具（`file_operation`）未实现，会明确报错；`chrome_screenshot` 仅存档（当前模型读不了图）。
- **前提**：Edge 已加载本扩展；调用具体站点接口（如余额）还需该站点已登录。

## 常见问题

**Q：接口返回 400 Bad Request，响应体是空的？**
GET 查询串里带了未编码的中文（`?q=人工智能`）。HTTP 请求行只允许 ASCII，Node 的解析器会在协议层直接拒绝。改用 POST + JSON body（中文零编码），或对参数做 URL 编码。

**Q：Edge 提示 host 未连接？**
重跑一次 `host/install.bat`（脚本会自愈路径与扩展 ID），然后在 `edge://extensions` 里重新加载扩展。

**Q：搜索接口返回 0 条？**
先看返回里的 `page_loaded` 与 `no_result`：`no_result: true` 表示搜索引擎确实返回了零结果页（不是失败）；两者都为 false 则可能是页面没加载完或触发了验证页，在 Edge 里手动访问一次该站点再重试。

## 许可证与署名

本项目采用 [MIT 许可证](LICENSE)。

`extension/` 是在上游 **mcp-chrome-bridge**（npm 包名 `mcp-chrome-bridge`，浏览器插件版又称 chrome-mcp-server，MIT，© 2024 hangye）的基础上改造而来：保留其浏览器操作能力与 native messaging 协议，改造为「只提供 OpenAPI/MCP HTTP 服务、不提供 MCP 客户端连接」的桥接扩展，并替换为独立密钥与扩展 ID。上游许可条款见 [extension/LICENSE.upstream](extension/LICENSE.upstream)。
