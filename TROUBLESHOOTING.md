# 故障排查 —— Web To OpenAPI

> 本文是 [README](README.md) 的排障分册：**日志在哪、什么症状对应什么原因、怎么修**。
> 安装步骤见 README「部署」，接口参数见 [API.md](API.md)。

## 症状速查

| 症状 | 先看这里 |
|---|---|
| popup 显示「本地服务未运行」 | 下面「常见问题」第一问的三层排查；`host-launcher.log` 有没有新行 |
| popup 报 `Specified native messaging host not found` | **注册表层面**没注册，或指向已删除的旧目录 → 见[下一节](#提示specified-native-messaging-host-not-found)；跑 `host\install.bat` |
| `curl` 连不上 `127.0.0.1:8090` | 浏览器没开 / 扩展没加载 / host 没起来（见「运维说明·生命周期」） |
| cmd 里 `node -v` 正常，但日志说找不到 node | [为什么 cmd 里 node 能跑，浏览器却说找不到](#为什么-cmd-里-node-能跑浏览器却说找不到) |
| 接口 `400` 且响应体为空 | 中文走了 GET，改 POST（见 [API.md](API.md) 开头） |
| 接口 `503` + `needs_human: true` | 遇到登录页/验证码，按提示在浏览器里处理后再调 |
| 接口 `504` + 「页面没有渲染出任何内容」 | 浏览器窗口被最小化或完全遮挡，Chromium 冻结了不可见标签——把窗口露出来即可。原理与实测见 [README → 页面打开策略](README.md#页面打开策略默认不弹窗) |
| 搜索返回 `count: 0` | 先看 `page_loaded` / `no_result`，区分「真没结果」与「没加载完」 |
| 窗口模式下调了接口却没看到窗口 | 先看日志：`命中上次结果(同一请求)` = 同一文本 3 分钟内命中缓存，压根没碰浏览器；`pooled tab=... 已不存在` 后面紧跟 `open page mode=` = 已按 `page_mode` 重新开窗；两者都没有 = `page_mode` 实际是 `tab`（设置页只在 host 已连接时下发，保存后看设置页顶部的当前生效值） |
| 设置 `window-front`，只看到页面顶部闪一条含 **debug** 的黄条，没有窗口 | 那条黄条是 `chrome.debugger`（CDP）附着时 Chromium 的调试信息栏，读 DOM 完毕即消失，属正常现象。若窗口真没出现，见下一条 |
| `window-front` 第二次调用起窗口不再弹出来 | 旧版复用标签时只换 URL、不激活窗口，窗口被遮挡就完全看不到（只剩调试黄条一闪）。新版 [README → 页面打开策略](README.md#页面打开策略默认不弹窗) 已修：复用路径也会 `windows.update({focused:true})`。确认扩展已重新加载 |
| 设置页填了 `0.0.0.0` 后 popup 报服务未运行 | 目的地址仍要写 `127.0.0.1`，`0.0.0.0` 只能用于监听；代价见 [README → 隐私与安全](README.md#隐私与安全) |
| 改了设置页的值但行为没变 | 保存后扩展需重新加载；`page_mode` 只在扩展重连时下发（见 [README → 配置监听地址](README.md#配置监听地址--端口在插件设置里改)） |
| 扩展「错误」页刷出多条 `Permissions policy violation: unload is not allowed in this document.` | 旧版内容脚本注册了已废弃的 `unload` 监听器，每个标签页各记一条。新版改用 `pagehide`，升级后点「清除全部」即消失，见[下方问答](#常见问题) |
| 第二个浏览器 / 重开后报 `Error when communicating with the native messaging host`，且 `openapi-host.log` 里**没有任何新日志** | 已有一个 host 在跑，启动器打不开共享的 `host-stderr.log` 做追加，cmd 把整条启动命令作废 —— node 从未被执行，两个日志全空。新版已改由 host 自己追加写 stderr，见[下方问答](#常见问题) |
| 设置页填了新端口，保存成功但状态仍显示「本地服务未运行」 | 旧版 host 拒绝覆盖端口、而探测地址又跟着变。新版已打通：合法端口（1–65535）保存后立即重绑；若仍失败，看 `openapi-host.log` 里的 `http bind failed ... EADDRINUSE`（端口被别人占了） |

---

## 运维说明

- **生命周期**：host 由浏览器扩展拉起；浏览器退出 → host 退出 → HTTP 不可用（浏览器自动化的固有属性，与 chrome-mcp-server 一致）。
- **日志**（都在 `%LOCALAPPDATA%\webtoopenapi\logs\`）：
  - `openapi-host.log` —— host 的运行日志，`log()` 逐行追加打开。**多进程可同时追加**（两个浏览器、残留进程并存时互不干扰），「服务起不来 / 端口没切过去」主要看这里：`listen port changed 8090 -> 8099` 说明端口覆盖已生效，`http bind failed ... EADDRINUSE` 说明端口被占。
  - `host-stderr.log` —— host 进程的 stderr 副本（协议帧走 stdout，所以日志不能占 stdout）。由 `openapi-host.js` 顶部自己打开追加；**早期版本是让 `run_host.bat` 用 `2>>` 追加的，那会在第二个 host 启动时直接失败**，见[下方问答](#常见问题)。
  - `host-launcher.log` —— 启动器 `run_host.bat` 的流水：每次被浏览器拉起、node 的命中来源（`node source=`）、失败原因。**排「服务起不来」先看这个文件**：没有新行 = 浏览器根本没尝试拉起（最常见是注册表问题，见[「Specified native messaging host not found」](#提示specified-native-messaging-host-not-found)）；有 `ERROR: node.exe is not on PATH` = 浏览器进程的 PATH 里没有 node，紧随其后的 `launcher PATH=` 就是启动器当时看到的那条 PATH。
- **升级风险**：本服务不修改任何第三方包；`extension/` 是独立副本，原扩展与 bridge 升级都不受影响。
- **已知限制**：依赖下载/文件保存类的工具（`file_operation`）未实现，会明确报错；`chrome_screenshot` 仅存档（当前模型读不了图）。
- **前提**：浏览器（Edge / Chrome）已加载本扩展；调用具体站点接口（如余额）还需该站点已登录。

## 提示「Specified native messaging host not found」

这是**注册表层面**的失败，跟 node、跟 PATH 都无关：浏览器在
`HKCU\Software\{Microsoft\Edge | Google\Chrome}\NativeMessagingHosts\com.webtoopenapi.host`
找不到可用的注册项，或者注册项指向的 manifest 文件已经不存在。这种情况下
`host-launcher.log` 里**一行都不会有**——启动器根本没被拉起，所以别再往 PATH 上找。

> 早期版本的 popup 不管遇到什么错误都会提示「日志写 node.exe is not on PATH」，那是误导
> （已修，现在按错误类型给对应动作）。

### 最常见成因：换了目录却没重跑安装脚本

注册表里存的是 manifest 的**绝对路径**。更新版本时把新包解压到**另一个目录**、只重新加载了扩展，
注册表仍然指向上一个目录的 manifest；旧目录一旦删除或改名，浏览器就报这个错。

### 一眼确认

```powershell
reg query "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.webtoopenapi.host" /ve
```

Chrome 则是 `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.webtoopenapi.host`。三种结果：

| 返回 | 含义 | 该做什么 |
|---|---|---|
| 报「系统找不到指定的注册表项」 | 从没注册过，或注册项被删/被安全软件清掉 | 跑 `host\install.bat` |
| 有值，但指向的目录已不存在 | 就是本节场景（更新到新目录后没重新注册） | 跑 `host\install.bat` |
| 有值且文件确实存在 | 不是这个错，回到[症状速查](#症状速查)看别的行 | — |

### 修法

双击**当前这份包**里的 `host\install.bat`（别用旧目录里那个），它会：

- 把注册表指向**当前目录**的 manifest；
- 按扩展 key 重新推导 ID，写入 `allowed_origins`；
- 若发现旧注册项指向的文件已不存在，打印
  `[fix] key pointed at a MISSING manifest: ...`，并注明「这正是 not found 的成因」——
  看到这行就说明诊断命中，自愈已完成。

然后**完全退出浏览器**再打开（任务管理器里不能剩 `msedge` / `chrome` 进程）。

> 简单记法：**换目录 = 重跑一次 `install.bat`**；只是覆盖同一目录的文件则不必。

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
1. **浏览器有没有尝试拉起 host**：看 `%LOCALAPPDATA%\webtoopenapi\logs\host-launcher.log` 有没有新行。没有 → 扩展的 native 连接没建立。此时先看 popup 的「启动失败原因」：
   - 报 `Specified native messaging host not found` → 注册表没注册或指向已删除的旧目录，见[上一节](#提示specified-native-messaging-host-not-found)，跑 `host\install.bat`；
   - 报 `Access to the specified native messaging host is forbidden` → 扩展 ID 与 `allowed_origins` 不匹配，确认加载的是发布包里的 `extension/`，再跑 `install.bat`；
   - 什么都报不出来 → 扩展没加载/被禁用，或注册表键缺失，重跑 `host\install-host.ps1`。
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

**Q：扩展的「错误」页里刷出一堆 `Permissions policy violation: unload is not allowed in this document.`？**
这是旧版内容脚本留下的噪音，**不影响任何功能**。

- 来源：`content-scripts/element-picker.js` 与 `content-scripts/quick-panel.js` 注入 `<all_urls>`，旧版用 `window.addEventListener("unload", ...)` 做页面退出清理。Chromium 已把 `unload` 移出默认 Permissions Policy allowlist（`Permissions-Policy: unload=()`），对这类文档注册监听器就报这条 —— 注入到几个标签页就记几条，容易把真错误淹掉。
- 新版改法：换成 `pagehide`，并在 `event.persisted === true`（进 bfcache）时跳过清理，语义与原来一致但不再违规。
- 实测（Edge 155）：文档响应头带 `permissions-policy: unload=()` 时，注册 `unload` → 2 条违规（console + `Log.entryAdded/violation`）；注册 `pagehide` → 0 条。
- 处理：重新加载新版扩展 → 刷新已打开的标签页（内容脚本只对新页面生效）→ 在错误页点「清除全部」。

**Q：第二个浏览器（或残留 host）启动后报 `Error when communicating with the native messaging host`，而 `openapi-host.log` 里没有任何新日志？**
这是旧版启动器的自伤，**不是扩展或 node 的问题**，且排查起来很别扭：浏览器只给一句笼统的「native messaging host 通信失败」，而两个日志文件都是空的，看不出任何原因。

- 机制：`run_host.bat` 用 `2>> "%LOG_FILE%"` 把 host 的 stderr 追加到共享的 `host-stderr.log`。当已有一个 host 在跑（两个浏览器 / 残留进程 / 上一个还没退出），cmd 打不开这个文件做追加，报「另一个程序正在使用此文件」——**而重定向失败会让 cmd 把该行及其后剩下的命令全部作废**，node 从未被执行。启动器日志停在 `starting host` 那一行，host 侧一条记录都没有。
- 实测（ASCII 路径双开，修复前/后对照）：修复前第二个 bat 只报文件被占用、node 不执行；修复后两个 host 分别在 8091/8092 起服务，两个日志都正常写入。
- 修法：`2>>` 已从启动器里删除，改由 `openapi-host.js` 顶部用 `fs.openSync(..., "a")` 自己追加写 stderr —— node 的追加写允许多进程共存，cmd 层的重定向失败也就无从发生。
- 顺带说一句：同时跑两个 host 本身仍不建议，两个实例会争抢同一个端口（日志里是 `http bind failed ... EADDRINUSE`，输的那个每 5 秒重试一次），请求由哪个浏览器执行也不确定。要同时用两个浏览器，就在其中一个的插件设置里换个端口。

**Q：设置页填了新端口，保存时提示成功，状态却显示「本地服务未运行」？**
同样是旧版遗留：host 侧**刻意拒绝**扩展下发的端口覆盖，而扩展的探测地址又跟着变，于是「保存成功但探不到服务」。现在两端都打通了——host 接受 1–65535 的合法端口并立即重绑（`listen port changed 8090 -> 8099`），绑定失败时每 5 秒重试，不会永久起不来。保存后 popup 会退回状态视图，面板不关闭，可以直接看到新端口是否已生效。

**Q：点「保存并应用」后旁边出现 `已保存; 重连指令下发失败: The message port closed before a response was received.`？**
这句**不是保存失败**，配置已经落盘、后台也在按新地址重连，是消息通道在中途被关掉了。

- 机制：后台重连的第一步是断开旧的 native messaging 端口，而那个端口正是 MV3 service worker 最主要的 keepalive。断开后到重连成功有约 800ms 的空档，这期间 worker 可能被 Chrome 挂起，把我们这条消息的通道一起关掉 —— 于是 `chrome.runtime.lastError` 报 port closed。worker 什么时候被挂起取决于浏览器当时的负载，所以是**间歇性**的。
- 修法：`restart_native` 改成「先回包、后台干活」——立即回 `{success:true, scheduled:true}`，重连放到后台串行队列里跑，回包不再跨那 800ms 空档。同时设置页不再把 `lastError` 当错误上报：保存后它会自己 `fetch /health` 确认一次，状态栏直接显示「已按新地址端口生效」或「暂未监听（端口可能被占用，见日志 EADDRINUSE）」。
- 顺带修了排队语义：连点两次保存时，第二次的参数以前会被「正在重启中」直接丢掉（用户改了端口却毫无反应），现在紧跟在第一次之后生效。
