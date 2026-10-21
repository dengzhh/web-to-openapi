// Web To OpenAPI — clean popup page logic (no MCP/chrome-mcp references)
(function () {
  var DEFAULTS = { host: "127.0.0.1", port: 8090 };
  // 后台 service worker 空闲时会被挂起, 进而导致它拉起的 native host 进程退出、
  // 本地 HTTP 服务停止。打开本页先发 ensure_native 唤醒 worker 并重建连接, 再探测。
  var MAX_RETRY = 5;

  function el(id) { return document.getElementById(id); }
  function endpoint() {
    return "http://" + (window.__w2o_host || DEFAULTS.host) + ":" + (window.__w2o_port || DEFAULTS.port);
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
  function showNativeError() {
    if (!chrome || !chrome.storage || !chrome.storage.local) return;
    try {
      chrome.storage.local.get("nativeLastError", function (cfg) {
        var e = cfg && cfg.nativeLastError;
        if (!e || !e.message) return;
        if (e.at && Date.now() - e.at > 600000) return;
        var s = el("status");
        if (s) {
          s.textContent += "\n\n启动失败原因: " + e.message +
            "\n日志: %LOCALAPPDATA%\\webtoopenapi\\logs\\host-launcher.log" +
            "\n日志里若写 node.exe not found: 这台机器没装 Node.js, 装完要完全退出浏览器再开";
        }
      });
    } catch (err) { /* ignore */ }
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
    if (opt) opt.onclick = function () {
      if (chrome.runtime && chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
      else window.open(chrome.runtime.getURL("options.html"));
    };
    bindDocs();
  }

  function start() {
    setStatus("正在唤醒本地服务...", "");
    wakeNative(function () { retryProbe(0); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
