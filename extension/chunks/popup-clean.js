// Web To OpenAPI — clean popup page logic (no MCP/chrome-mcp references)
(function () {
  var DEFAULTS = { host: "127.0.0.1", port: 8090 };
  // 后台 service worker 空闲时会被挂起, 进而导致它拉起的 native host 进程退出、
  // 本地 HTTP 服务停止。打开本页先发 ensure_native 唤醒 worker 并重建连接, 再探测。
  var MAX_RETRY = 5;

  function el(id) { return document.getElementById(id); }
  // 探测地址永远走回环: 0.0.0.0 / :: 只表示"监听所有网卡", 不是可访问的目的地址
  // (Chromium 直接拒绝 fetch http://0.0.0.0:...), 拿它拼 URL 会让本页误报"服务未运行"。
  function probeHost() {
    var h = String(window.__w2o_host || DEFAULTS.host).trim();
    if (h === "0.0.0.0" || h === "::" || h === "[::]") return "127.0.0.1";
    return h;
  }
  function endpoint() {
    return "http://" + probeHost() + ":" + (window.__w2o_port || DEFAULTS.port);
  }
  function setStatus(text, cls) {
    var s = el("status");
    if (!s) return;
    s.textContent = text;
    s.className = "status " + (cls || "");
  }
  function bindDocs() {
    var btn = el("openDocs");
    if (btn) btn.onclick = function () { window.open(endpoint() + "/docs", "_blank", "noopener"); };
  }

  // 唤醒后台 service worker 并重建 native host 连接。回调收到 resp(可能为 null)。
  function wakeNative(cb) {
    if (chrome && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        var p = chrome.runtime.sendMessage({ type: "ensure_native" });
        if (p && typeof p.then === "function") {
          p.then(function (r) { cb(r || null); }).catch(function () { cb(null); });
          return;
        }
      } catch (e) { /* 落到 cb(null) */ }
    }
    cb(null);
  }

  // 探测 /health, 通过 done(ok) 返回结果。
  function probeOnce(done) {
    var url = endpoint() + "/health";
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 2500);
    fetch(url, { signal: ctrl.signal })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        clearTimeout(timer);
        if (chrome && chrome.storage && chrome.storage.local) {
          try { chrome.storage.local.remove("nativeLastError"); } catch (e) { /* ignore */ }
        }
        var addr = d.listen || endpoint();
        var ext = d.extension_connected ? "扩展已连接" : "扩展未连接";
        setStatus(addr + "\n" + ext + " · 已运行 " + (d.uptime_s || 0) + "s", "ok");
        bindDocs();
        done(true);
      })
      .catch(function () {
        clearTimeout(timer);
        done(false);
      });
  }

  function retryProbe(attempt) {
    probeOnce(function (ok) {
      if (ok) return;
      if (attempt < MAX_RETRY) {
        setStatus("正在启动本地服务" + (attempt > 0 ? " (" + attempt + "/" + MAX_RETRY + ")" : "") + "...", "");
        setTimeout(function () { retryProbe(attempt + 1); }, 400);
      } else {
        setStatus("本地服务未运行\n(确认 Edge 已打开且已加载本扩展)", "bad");
        showNativeError();
        bindDocs();
      }
    });
  }

  // 探测彻底失败时展示后台记录的 native 断开原因(如 "Specified native messaging
  // host not found" / "Native host has exited")。键名字符量必须与 background.js 的
  // STORAGE_KEYS.NATIVE_LAST_ERROR 保持一致; 没有记录就静默跳过。
  // 只展示 10 分钟内的记录, 避免陈旧的断开原因误导排查。
  // 按错误类型给"该做什么"。历史教训: 这三行曾经是写死的固定文案(永远建议去查 PATH),
  // 但 "Specified native messaging host not found" 是注册表层面的失败 —— 那种情况
  // host-launcher.log 里一行都不会有, 让用户去查 PATH 纯属误导。
  function nativeAdvice(msg) {
    var m = String(msg || "");
    if (/native messaging host not found/i.test(m)) {
      return "\n→ 注册表里没有这个 host(或它指向的 manifest 文件已不存在)。" +
        "\n  双击 host\\install.bat 重新注册(会把注册表指向当前目录的 manifest)," +
        "\n  然后完全退出浏览器再打开。";
    }
    if (/is forbidden/i.test(m)) {
      return "\n→ 扩展 ID 与 manifest 的 allowed_origins 不匹配。" +
        "\n  确认加载的是发布包里的 extension\\ 目录(manifest 自带公钥会锁定 ID)," +
        "\n  再双击 host\\install.bat 重新注册。";
    }
    if (/has exited|was found but failed|not found via/i.test(m)) {
      return "\n→ 启动器被拉起后立即退出。" +
        "\n  看 %LOCALAPPDATA%\\webtoopenapi\\logs\\host-launcher.log:" +
        "\n  写 node.exe is not on PATH = node 不在浏览器进程的 PATH 里。" +
        "\n  写 no launcher / manifest path = run_host.bat 路径失效, 重跑 install.bat。";
    }
    return "\n→ 看 %LOCALAPPDATA%\\webtoopenapi\\logs\\ 下的" +
      "\n  host-launcher.log(启动器) / host-stderr.log(服务自身)。";
  }

  function showNativeError() {
    if (!chrome || !chrome.storage || !chrome.storage.local) return;
    try {
      chrome.storage.local.get("nativeLastError", function (cfg) {
        var e = cfg && cfg.nativeLastError;
        if (!e || !e.message) return;
        if (e.at && Date.now() - e.at > 600000) return;
        var s = el("status");
        if (s) {
          s.textContent += "\n\n启动失败原因: " + e.message + nativeAdvice(e.message);
        }
      });
    } catch (err) { /* ignore */ }
  }

  // 两个视图在同一面板内切换: 设置走 iframe(复用 options.html), 不再
  // chrome.runtime.openOptionsPage() 跳新标签页 —— 那样会抢焦点, 看完状态还得
  // 回原页面重新找插件图标。iframe 只在首次切到设置时加载, 返回时不重载,
  // 用户填了一半的内容不会丢。
  function showView(name) {
    var st = el("viewStatus");
    var se = el("viewSettings");
    if (!st || !se) return;
    var toSettings = name === "settings";
    st.style.display = toSettings ? "none" : "flex";
    se.style.display = toSettings ? "block" : "none";
    if (toSettings) {
      var f = el("optFrame");
      if (f && !f.getAttribute("src")) f.src = "options.html";
    }
  }

  function init() {
    if (chrome && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(["webtoopenapi_host", "webtoopenapi_port"], function (cfg) {
        window.__w2o_host = cfg.webtoopenapi_host || DEFAULTS.host;
        window.__w2o_port = cfg.webtoopenapi_port || DEFAULTS.port;
        start();
      });
    } else { start(); }

    var opt = el("openOptions");
    if (opt) opt.onclick = function () { showView("settings"); };

    var back = el("backStatus");
    if (back) back.onclick = function () { showView("status"); start(); };

    // 逃生口: 面板里地方小, 需要细看/长表单时还是开整页
    var tabBtn = el("openOptionsTab");
    if (tabBtn) tabBtn.onclick = function () {
      if (chrome.runtime && chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
      else window.open(chrome.runtime.getURL("options.html"), "_blank", "noopener");
    };
    showView("status");
    bindDocs();
  }

  function start() {
    setStatus("正在唤醒本地服务...", "");
    wakeNative(function () { retryProbe(0); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
