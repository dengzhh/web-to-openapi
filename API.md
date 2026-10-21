# API 参考 —— Web To OpenAPI

> 本文是 [README](README.md) 的接口分册：**完整端点清单、每个参数的含义、返回字段、MCP 接入方式**。
> 安装与原理见 [README](README.md)，装不上或调不通见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。

- 默认地址：`http://127.0.0.1:8090`（地址/端口可在插件设置里改，见 README「配置监听地址 / 端口」）
- 同一进程同一端口同时提供 REST 与 MCP（`/mcp`），两份接口由同一份实现派生
- 在线自描述：`GET /openapi.json`（OpenAPI 3.0，可导入 Postman）、`GET /docs`（可在线试调）

> **中文查询词必须用 POST**：HTTP 请求行只允许 ASCII，`?q=人工智能` 不编码会被 Node 的 HTTP 解析器在协议层直接打回 `400 Bad Request`（空响应体，路由代码都进不去）。POST 用 JSON body，中文零编码。

---

## 目录

- [API 一览](#api-一览)——所有端点一张表
- [百度搜索](#百度搜索完整高级查询参数)· [谷歌搜索](#谷歌搜索完整高级查询参数)· [在线翻译](#在线翻译统一入口--引擎表)
- [设置页默认参数](#在插件设置页配置默认查询参数)——三层合并规则
- [SCNet 示例接口的返回](#scnet-余额接口的返回示例)
- [MCP 服务](#mcp-服务与-rest-接口一一对应)——把同一批能力暴露给 MCP 客户端

---

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

返回：`translation`（整段译文）· `segments`（按段落/行拆分，多段文本有用）· `from` / `to`（归一化后的代码，`zh-TW` 会回显为 `cht`）· `from_label` / `to_label`（页面实际识别的语言，可用来核对方向）· `reused`（本次是否复用了已打开的页面）· `cached`（是否命中上一次相同请求的结果）· `elapsed_ms`。

**学习资料**（`detail=true` 默认附带，`detail=false` 只回主译文；解析失败只是为空，不影响主流程）：

| 字段 | 内容 | 出现的查询类型 |
|---|---|---|
| `dict` | 重点词汇 `[{word, defs}]`（句子里的关键词及释义） | 整句 |
| `details_text` | 词典卡原文（best-effort，给想自己解析的人） | 整句 / 单词 |
| `phonetic` | 英式 / 美式音标 `{uk, us}` | 单词 / 短语 |
| `simple_def` | 简明释义（词性 + 中文释义，如 `n. 恢复力；弹力；适应力`） | 单词 / 短语 |
| `examples` | 双语例句 `[{no, src, dst}]`，通常 5 条，源语句 + 译文成对 | 单词 / 短语 |
| `explanation` | AI 译法解析长文（同一词多种译法的适用语境对比） | 单词 / 短语 |

实测（2026-10，百度翻译）：英→中、中→英、`auto` 自动检测、多段文本、`detail=false`、ISO 别名（`ja` / `ko` / `fr` / `es` / `zh-TW`）均通过；54 种语言逐一跑过「Hello, good morning.」→ 目标语，全部返回对应语种译文。单词查询（`machine learning` / `resilience` / `学习`）的音标、简明释义、5 条双语例句、译法解析均实测拿到。页面结构要点：译文容器是稳定 id `#trans-selection`（不是混淆类名），所以比搜索类站点抗改版；词典卡以文本「简明释义」定位，完成标记有「以上为AI翻译结果 / 以上为机器翻译结果」两种文案（同一单词查询两种都出现过），都认。

> 页面上「翻译详解 / 关键术语解释 / 专家审校」按钮点击后会弹**登录框**，未登录拿不到内容，API 不碰这三项（也不替用户登录）。

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

## SCNet 余额接口的返回示例

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
