# 故障排查 —— Web To OpenAPI

> 本文是 [README](README.md) 的排障分册：**日志在哪、什么症状对应什么原因、怎么修**。
> 安装步骤见 README「部署」，接口参数见 [API.md](API.md)。

## 症状速查

| 症状 | 先看这里 |
|---|---|
| popup 显示「本地服务未运行」 | 下面「常见问题」第一问的三层排查；`host-launcher.log` 有没有新行 |
| `curl` 连不上 `127.0.0.1:8090` | 浏览器没开 / 扩展没加载 / host 没起来（见「运维说明·生命周期」） |
| cmd 里 `node -v` 正常，但日志说找不到 node | [为什么 cmd 里 node 能跑，浏览器却说找不到](#为什么-cmd-里-node-能跑浏览器却说找不到) |
| 接口 `400` 且响应体为空 | 中文走了 GET，改 POST（见 [API.md](API.md) 开头） |
| 接口 `503` + `needs_human: true` | 遇到登录页/验证码，按提示在浏览器里处理后再调 |
| 接口 `504` + 「页面没有渲染出任何内容」 | 浏览器窗口被最小化或完全遮挡，Chromium 冻结了不可见标签——把窗口露出来即可。原理与实测见 [README → 页面打开策略](README.md#页面打开策略默认不弹窗) |
| 搜索返回 `count: 0` | 先看 `page_loaded` / `no_result`，区分「真没结果」与「没加载完」 |
| 设置页填了 `0.0.0.0` 后 popup 报服务未运行 | 目的地址仍要写 `127.0.0.1`，`0.0.0.0` 只能用于监听；代价见 [README → 隐私与安全](README.md#隐私与安全) |
| 改了设置页的值但行为没变 | 保存后扩展需重新加载；`page_mode` 只在扩展重连时下发（见 [README → 配置监听地址](README.md#配置监听地址--端口在插件设置里改)） |

---

## 运维说明

- **生命周期**：host 由浏览器扩展拉起；浏览器退出 → host 退出 → HTTP 不可用（浏览器自动化的固有属性，与 chrome-mcp-server 一致）。
- **日志**（都在 `%LOCALAPPDATA%\webtoopenapi\logs\`）：
  - `host-stderr.log` —— host 自身的运行日志（协议走 stdout，日志只走 stderr + 文件）；
  - `host-launcher.log` —— 启动器 `run_host.bat` 的流水：每次被浏览器拉起、node 的命中来源（`node source=`）、失败原因。**排「服务起不来」先看这个文件**：没有新行 = 浏览器根本没尝试拉起；有 `ERROR: node.exe is not on PATH` = 浏览器进程的 PATH 里没有 node，紧随其后的 `launcher PATH=` 就是启动器当时看到的那条 PATH。
- **升级风险**：本服务不修改任何第三方包；`extension/` 是独立副本，原扩展与 bridge 升级都不受影响。
- **已知限制**：依赖下载/文件保存类的工具（`file_operation`）未实现，会明确报错；`chrome_screenshot` 仅存档（当前模型读不了图）。
- **前提**：浏览器（Edge / Chrome）已加载本扩展；调用具体站点接口（如余额）还需该站点已登录。

## 为什么 cmd 里 node 能跑，浏览器却说找不到

这是 Windows 上「本地服务未运行」最常见的原因，也是本项目**唯一一个纯环境问题**——不是 bug，是环境变量的传递规则。

### 原理：没有「给 host 设环境变量」的地方

native messaging manifest 只有 5 个字段：`name` / `description` / `path` / `type` / `allowed_origins`（Chrome 官方文档口径），**没有 `env` 字段**。host 是浏览器用 `CreateProcess` 拉起的普通子进程，环境块直接复制浏览器进程那一份：

```
浏览器进程的环境块 ──CreateProcess──> cmd.exe 执行 run_host.bat ──> node.exe
       ↑
  这份快照是浏览器「启动那一刻」从父进程（通常 explorer.exe）继承的
```

于是同一台机器上存在**两份互不相干的 PATH**：

| 你在哪看 | 这份 PATH 来自 | 典型现象 |
|---|---|---|
| 自己开的 cmd / PowerShell | 终端进程启动时读取 | `where node` 有结果 → 以为万事大吉 |
| 浏览器拉起的 host | **浏览器进程**的环境块 | 日志写 `ERROR: node.exe is not on PATH` |

关键点：**已经在运行的进程不会因为 `setx` 而更新环境**。`setx` 只改注册表里的持久值，正在跑的 explorer、正在跑的浏览器，各自还握着启动那一刻的那份副本；新进程继承的永远是**父进程当时那份**。所以「改了系统环境变量却没生效」是常态，不是异常。

### 三步自查（30 秒）

1. 看自己这份：`cmd /c "where node & echo %PATH%"` —— 有 node 就说明这份是好的；
2. 看浏览器那份：`%LOCALAPPDATA%\webtoopenapi\logs\host-launcher.log` 里的 `launcher PATH=` 一行，就是**浏览器当时传给启动器的真实环境**，直接跟第 1 步的结果逐段对比；
3. 日志若是 `ERROR: node.exe is not on PATH`，把紧随其后的 `searched: ...` 与 `launcher PATH=` 贴出来，路径差异一眼可见。

### 四种修法（按推荐度）

| 修法 | 命令 / 动作 | 说明 |
|---|---|---|
| 一、装 Node.js LTS | `winget install OpenJS.NodeJS.LTS` | 安装器自己写系统 PATH，之后**完全退出浏览器**再开 |
| 二、把已有 node 目录加进系统 PATH | 系统属性 → 环境变量 → 系统变量 `Path` → 新增 node.exe 所在目录 | 不重复安装，复用现有的那一份 |
| 三、从终端带着新环境启动浏览器 | 先退出所有浏览器进程，再 `set PATH=C:\path\to\node;%PATH% && start "" msedge` | 不落盘、只对本次进程树有效；**已有实例在跑时 `start` 只在旧实例开新窗口**，等于无效 |
| 四、`node-path.txt` 覆盖（兜底） | 在 `host\` 下新建该文件，一行写 node.exe 全路径、不带引号 | 唯一不依赖环境传递的方式，适合不能动 PATH 的受管机器 |

启动器只认三处，按顺序：`node-path.txt` → `WEBTOOPENAPI_NODE` → PATH（再用 `where node.exe` 复核，防 PATH 里的引号写法漏掉）。**不做任何目录扫描**：私有目录布局随时会变，写死一堆路径只会长期失效。命中来源记在日志的 `node source=`。

### 「重启机器能好」只在一种情况下成立

| 你的情况 | 重启机器 | 真正该做的 |
|---|---|---|
| cmd 里**也没有** node | ❌ 无用，重启不会凭空生出一个 node.exe | 装 Node.js，或把 node 目录加进 PATH |
| cmd 里 `node -v` **正常** | ✅ 有效，因为重启让 explorer 全新读一次环境 | 但更省事的是**完全退出浏览器**再开（等效，几十秒） |

「完全退出」指：关闭所有窗口还不够，要在任务管理器里结束所有 `msedge.exe` / `chrome.exe` 残留进程。只关窗口的话，后台进程还握着旧环境，新窗口复用同一进程 = PATH 依旧是旧的。

## 常见问题

**Q：接口返回 400 Bad Request，响应体是空的？**
GET 查询串里带了未编码的中文（`?q=人工智能`）。HTTP 请求行只允许 ASCII，Node 的解析器会在协议层直接拒绝。改用 POST + JSON body（中文零编码），或对参数做 URL 编码。

**Q：浏览器提示 host 未连接？**
重跑一次 `host/install.bat`（脚本会自愈路径与扩展 ID），然后在 `edge://extensions`（Chrome 则 `chrome://extensions`）里重新加载扩展。

**Q：popup 显示「本地服务未运行」，重开浏览器也没用？**
按顺序查三层，每层都有明确判据：
1. **浏览器有没有尝试拉起 host**：看 `%LOCALAPPDATA%\webtoopenapi\logs\host-launcher.log` 有没有新行。没有 → 扩展的 native 连接没建立（扩展没加载/被禁用，或注册表键缺失——重跑 `host/install-host.ps1`）。
2. **拉起了但启动器失败**：同一文件里有 `ERROR: node.exe is not on PATH` 和一条 `launcher PATH=` —— 浏览器进程的 PATH 里找不到 node。**为什么 cmd 里 `where node` 能用、浏览器却说没有**，原理、三步自查与四种修法见专节 [为什么 cmd 里 node 能跑，浏览器却说找不到](#为什么-cmd-里-node-能跑浏览器却说找不到)。
   最短修法：让 node 进 PATH（`winget install OpenJS.NodeJS.LTS`，或把已有 node 目录加进系统 PATH），然后**完全退出浏览器**再开；不能动 PATH 的受管机器用 `host\node-path.txt` 兜底。
3. **popup 里的「启动失败原因」**：探测彻底失败时，popup 会把扩展记录的上一次 native 断开原因直接显示出来（如 `Access to the specified native messaging host is forbidden` = 扩展 ID 与 manifest 的 `allowed_origins` 不匹配——确认加载的是发布包里的 `extension/` 目录，manifest 自带公钥会锁定 ID；`Native host has exited` = 启动器起来了又退出，回到第 2 步看 launcher 日志）。

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
