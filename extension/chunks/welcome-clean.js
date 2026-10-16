// Web To OpenAPI — clean welcome page logic (no MCP/chrome-mcp references)
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
    if (!btn) return;
    btn.onclick = function () { window.open(endpoint() + "/docs", "_blank", "noopener"); };
  }

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

  function probeOnce(done) {
    var url = endpoint() + "/health";
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 2500);
    fetch(url, { signal: ctrl.signal })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        clearTimeout(timer);
        var addr = d.listen || endpoint();
        if (el("svcAddr")) el("svcAddr").textContent = addr;
        var ext = d.extension_connected ? "扩展已连接" : "扩展未连接";
        var up = (d.uptime_s != null) ? (" · 已运行 " + d.uptime_s + "s") : "";
        setStatus("本地服务运行中: " + addr + " · " + ext + up, "ok");
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
        setStatus("本地服务未运行 (确认 Edge 已打开且已加载本扩展)", "bad");
        bindDocs();
      }
    });
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
