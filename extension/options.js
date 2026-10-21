// Web To OpenAPI 设置页逻辑
// 配置保存在 chrome.storage.local:
//   webtoopenapi_host / webtoopenapi_port   -> 服务监听地址(保存后 chrome.runtime.reload())
//   webtoopenapi_behavior(JSON 字符串)      -> 浏览器行为 page_mode/keep_tab_ms(经消息下发 host, 不重载扩展)
//   webtoopenapi_baidu_defaults(JSON 字符串) -> 百度搜索默认参数(经消息下发 host, 不重载扩展)
//   webtoopenapi_google_defaults(JSON 字符串) -> 谷歌搜索默认参数(经消息下发 host, 不重载扩展)
(function () {
  "use strict";
  var DEFAULTS = { host: "127.0.0.1", port: 8090 };
  var BAIDU_KEY = "webtoopenapi_baidu_defaults";
  var GOOGLE_KEY = "webtoopenapi_google_defaults";
  var BEHAVIOR_KEY = "webtoopenapi_behavior";
  var BEHAVIOR_DEFAULTS = { page_mode: "auto", keep_tab_ms: 180000 };
  var $ = function (id) { return document.getElementById(id); };

  function probeService(host, port) {
    host = host || DEFAULTS.host;
    port = port || DEFAULTS.port;
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 2500);
    fetch("http://" + host + ":" + port + "/health", { signal: ctrl.signal })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        clearTimeout(timer);
        $("current").textContent = d.listen + " (运行中, 扩展已连接: " + d.extension_connected + ")";
      })
      .catch(function () {
        clearTimeout(timer);
        $("current").textContent = "未检测到本地服务(可能尚未启动, 或地址/端口已更改)";
      });
  }

  // 后台 service worker 空闲时会被挂起, 导致它拉起的 native host 退出、HTTP 服务停止。
  // 设置页打开时先发 ensure_native 唤醒 worker 并重建连接, 再探测状态。
  function wakeThenProbe(host, port) {
    if (chrome && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        var p = chrome.runtime.sendMessage({ type: "ensure_native" });
        if (p && typeof p.then === "function") {
          p.then(function () { probeService(host, port); }).catch(function () { probeService(host, port); });
          return;
        }
      } catch (e) { /* 落到下面的直接探测 */ }
    }
    probeService(host, port);
  }

  function load() {
    chrome.storage.local.get(["webtoopenapi_host", "webtoopenapi_port"], function (cfg) {
      var host = cfg.webtoopenapi_host || DEFAULTS.host;
      var port = cfg.webtoopenapi_port || DEFAULTS.port;
      $("host").value = host;
      $("port").value = port;
      wakeThenProbe(host, port);
      probeBehavior(host, port);
    });
  }

  function save() {
    var host = ($("host").value || "").trim() || DEFAULTS.host;
    var port = parseInt($("port").value, 10);
    if (!port || port < 1 || port > 65535) port = DEFAULTS.port;
    chrome.storage.local.set({ webtoopenapi_host: host, webtoopenapi_port: port }, function () {
      var s = $("status");
      s.textContent = "已保存, 正在重新加载扩展以应用 " + host + ":" + port + " ...";
      // 让提示先渲染, 再重载
      setTimeout(function () { chrome.runtime.reload(); }, 600);
    });
  }

  function reset() {
    $("host").value = DEFAULTS.host;
    $("port").value = DEFAULTS.port;
    save();
  }

  // ------------------------------------------------ 浏览器行为(page_mode / keep_tab_ms)
  function readBehaviorForm() {
    var d = {};
    d.page_mode = $("page_mode").value || BEHAVIOR_DEFAULTS.page_mode;
    var sec = parseInt($("keep_tab_sec").value, 10);
    d.keep_tab_ms = isNaN(sec) || sec < 0 ? BEHAVIOR_DEFAULTS.keep_tab_ms : sec * 1000;
    return d;
  }

  function fillBehaviorForm(d) {
    d = d || {};
    $("page_mode").value = d.page_mode || BEHAVIOR_DEFAULTS.page_mode;
    var ms = d.keep_tab_ms == null ? BEHAVIOR_DEFAULTS.keep_tab_ms : d.keep_tab_ms;
    $("keep_tab_sec").value = String(Math.round(ms / 1000));
  }

  function loadBehavior() {
    chrome.storage.local.get([BEHAVIOR_KEY], function (cfg) {
      var d = {};
      try { d = JSON.parse(cfg[BEHAVIOR_KEY] || "{}") || {}; } catch (e) { d = {}; }
      fillBehaviorForm(d);
    });
  }

  // 显示 host 当前生效值(可能与本表单不同: 比如 host 没连上时下发失败)
  function probeBehavior(host, port) {
    host = host || DEFAULTS.host;
    port = port || DEFAULTS.port;
    // 0.0.0.0 / :: 是"监听所有网卡", 不能当目的地址用(Chromium 直接拒绝), 探测走回环
    if (host === "0.0.0.0" || host === "::" || host === "[::]") host = "127.0.0.1";
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 2500);
    fetch("http://" + host + ":" + port + "/health", { signal: ctrl.signal })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        clearTimeout(timer);
        var ov = d.config_override || {};
        var src = Object.keys(ov).length ? "设置页覆盖" : "config.json / 环境变量";
        $("current-behavior").textContent =
          "page_mode=" + d.page_mode + ", keep_tab_ms=" + d.keep_tab_ms + " (" + src + ")";
      })
      .catch(function () {
        clearTimeout(timer);
        $("current-behavior").textContent = "未检测到本地服务(保存后下次连接时自动同步)";
      });
  }

  function saveBehavior() {
    var d = readBehaviorForm();
    var s = $("behavior-status");
    s.textContent = "保存中...";
    chrome.storage.local.set({ webtoopenapi_behavior: JSON.stringify(d) }, function () {
      chrome.runtime.sendMessage({ type: "set_service_config", config: d }, function (resp) {
        var err = chrome.runtime.lastError;
        if (err) { s.textContent = "已存入扩展; 但下发失败: " + err.message; return; }
        if (resp && resp.pushed) {
          s.textContent = "已保存并生效(本地服务已接收)";
          // 回读 host 当前生效值, 确认真的改掉了(而不是只存进了扩展)
          chrome.storage.local.get(["webtoopenapi_host", "webtoopenapi_port"], function (cfg) {
            probeBehavior(cfg.webtoopenapi_host || DEFAULTS.host, cfg.webtoopenapi_port || DEFAULTS.port);
          });
        } else {
          s.textContent = "已存入扩展; 本地服务未连接, 下次连接时自动同步";
        }
      });
    });
  }

  function resetBehavior() {
    var s = $("behavior-status");
    chrome.storage.local.remove(BEHAVIOR_KEY, function () {
      fillBehaviorForm({});
      chrome.runtime.sendMessage({ type: "reset_service_config" }, function (resp) {
        var err = chrome.runtime.lastError;
        if (err) { s.textContent = "已恢复默认; 下发失败: " + err.message; return; }
        s.textContent = "已恢复默认并生效";
      });
    });
  }

  // ------------------------------------------------ 百度搜索默认参数
  function splitList(v) {
    return String(v || "").split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function readBaiduForm() {
    var d = {};
    var site = splitList($("baidu_site").value);
    var intitle = splitList($("baidu_intitle").value);
    var inurl = splitList($("baidu_inurl").value);
    var exclude = splitList($("baidu_exclude").value);
    if (site.length) d.site = site;
    if (intitle.length) d.intitle = intitle;
    if (inurl.length) d.inurl = inurl;
    if (exclude.length) d.exclude = exclude;
    if ($("baidu_exact").value.trim()) d.exact = $("baidu_exact").value.trim();
    if ($("baidu_filetype").value) d.filetype = $("baidu_filetype").value;
    d.rn = parseInt($("baidu_rn").value, 10) || 50;
    if ($("baidu_time").value) d.time = $("baidu_time").value;
    if ($("baidu_resolve").checked) d.resolve_urls = true;
    return d;
  }

  function fillBaiduForm(d) {
    d = d || {};
    $("baidu_site").value = (d.site || []).join(", ");
    $("baidu_intitle").value = (d.intitle || []).join(", ");
    $("baidu_inurl").value = (d.inurl || []).join(", ");
    $("baidu_exclude").value = (d.exclude || []).join(", ");
    $("baidu_exact").value = d.exact || "";
    $("baidu_filetype").value = d.filetype || "";
    $("baidu_rn").value = String(d.rn || 50);
    $("baidu_time").value = d.time || "";
    $("baidu_resolve").checked = !!d.resolve_urls;
  }

  function loadBaidu() {
    chrome.storage.local.get([BAIDU_KEY], function (cfg) {
      var d = {};
      try { d = JSON.parse(cfg[BAIDU_KEY] || "{}") || {}; } catch (e) { d = {}; }
      fillBaiduForm(d);
    });
  }

  function saveBaidu() {
    var d = readBaiduForm();
    var s = $("baidu-status");
    s.textContent = "保存中...";
    chrome.storage.local.set({ webtoopenapi_baidu_defaults: JSON.stringify(d) }, function () {
      chrome.runtime.sendMessage({ type: "set_baidu_defaults", defaults: d }, function (resp) {
        var err = chrome.runtime.lastError;
        if (err) { s.textContent = "已存入扩展; 但下发失败: " + err.message; return; }
        if (resp && resp.pushed) s.textContent = "已保存并生效(本地服务已接收)";
        else s.textContent = "已存入扩展; 本地服务未连接, 下次连接时自动同步";
      });
    });
  }

  function resetBaidu() {
    var s = $("baidu-status");
    chrome.storage.local.remove(BAIDU_KEY, function () {
      fillBaiduForm({});
      chrome.runtime.sendMessage({ type: "set_baidu_defaults", defaults: {} }, function (resp) {
        var err = chrome.runtime.lastError;
        if (err) { s.textContent = "已清空; 下发失败: " + err.message; return; }
        if (resp && resp.pushed) s.textContent = "已清空并生效";
        else s.textContent = "已清空; 本地服务未连接, 下次连接时自动同步";
      });
    });
  }

  // ------------------------------------------------ Google 搜索默认参数
  function readGoogleForm() {
    var d = {};
    var site = splitList($("gg_site").value);
    var intitle = splitList($("gg_intitle").value);
    var inurl = splitList($("gg_inurl").value);
    var intext = splitList($("gg_intext").value);
    var exclude = splitList($("gg_exclude").value);
    var or = splitList($("gg_or").value);
    if (site.length) d.site = site;
    if (intitle.length) d.intitle = intitle;
    if (inurl.length) d.inurl = inurl;
    if (intext.length) d.intext = intext;
    if (exclude.length) d.exclude = exclude;
    if (or.length) d.or = or;
    if ($("gg_exact").value.trim()) d.exact = $("gg_exact").value.trim();
    if ($("gg_link").value.trim()) d.link = $("gg_link").value.trim();
    if ($("gg_filetype").value) d.filetype = $("gg_filetype").value;
    d.num = parseInt($("gg_num").value, 10) || 20;
    if ($("gg_time").value) d.time = $("gg_time").value;
    if ($("gg_safe").value) d.safe = $("gg_safe").value;
    if ($("gg_hl").value.trim()) d.hl = $("gg_hl").value.trim();
    if ($("gg_gl").value.trim()) d.gl = $("gg_gl").value.trim().toLowerCase();
    if ($("gg_lr").value.trim()) d.lr = $("gg_lr").value.trim();
    if ($("gg_cr").value.trim()) d.cr = $("gg_cr").value.trim();
    if ($("gg_tbm").value) d.tbm = $("gg_tbm").value;
    if ($("gg_after").value.trim()) d.after = $("gg_after").value.trim();
    if ($("gg_before").value.trim()) d.before = $("gg_before").value.trim();
    if ($("gg_resolve").checked) d.resolve_urls = true;
    if ($("gg_nfpr").checked) d.nfpr = true;
    if ($("gg_verbatim").checked) d.verbatim = true;
    return d;
  }

  function fillGoogleForm(d) {
    d = d || {};
    $("gg_site").value = (d.site || []).join(", ");
    $("gg_intitle").value = (d.intitle || []).join(", ");
    $("gg_inurl").value = (d.inurl || []).join(", ");
    $("gg_intext").value = (d.intext || []).join(", ");
    $("gg_exclude").value = (d.exclude || []).join(", ");
    $("gg_or").value = (d.or || []).join(", ");
    $("gg_exact").value = d.exact || "";
    $("gg_link").value = d.link || "";
    $("gg_filetype").value = d.filetype || "";
    $("gg_num").value = String(d.num || 20);
    $("gg_time").value = d.time || "";
    $("gg_safe").value = d.safe || "";
    $("gg_hl").value = d.hl || "";
    $("gg_gl").value = d.gl || "";
    $("gg_lr").value = d.lr || "";
    $("gg_cr").value = d.cr || "";
    $("gg_tbm").value = d.tbm || "";
    $("gg_after").value = d.after || "";
    $("gg_before").value = d.before || "";
    $("gg_resolve").checked = !!d.resolve_urls;
    $("gg_nfpr").checked = !!d.nfpr;
    $("gg_verbatim").checked = !!d.verbatim;
  }

  function loadGoogle() {
    chrome.storage.local.get([GOOGLE_KEY], function (cfg) {
      var d = {};
      try { d = JSON.parse(cfg[GOOGLE_KEY] || "{}") || {}; } catch (e) { d = {}; }
      fillGoogleForm(d);
    });
  }

  function saveGoogle() {
    var d = readGoogleForm();
    var s = $("google-status");
    s.textContent = "保存中...";
    chrome.storage.local.set({ webtoopenapi_google_defaults: JSON.stringify(d) }, function () {
      chrome.runtime.sendMessage({ type: "set_google_defaults", defaults: d }, function (resp) {
        var err = chrome.runtime.lastError;
        if (err) { s.textContent = "已存入扩展; 但下发失败: " + err.message; return; }
        if (resp && resp.pushed) s.textContent = "已保存并生效(本地服务已接收)";
        else s.textContent = "已存入扩展; 本地服务未连接, 下次连接时自动同步";
      });
    });
  }

  function resetGoogle() {
    var s = $("google-status");
    chrome.storage.local.remove(GOOGLE_KEY, function () {
      fillGoogleForm({});
      chrome.runtime.sendMessage({ type: "set_google_defaults", defaults: {} }, function (resp) {
        var err = chrome.runtime.lastError;
        if (err) { s.textContent = "已清空; 下发失败: " + err.message; return; }
        if (resp && resp.pushed) s.textContent = "已清空并生效";
        else s.textContent = "已清空; 本地服务未连接, 下次连接时自动同步";
      });
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    load();
    loadBehavior();
    loadBaidu();
    loadGoogle();
    $("save").addEventListener("click", save);
    $("reset").addEventListener("click", reset);
    $("save-behavior").addEventListener("click", saveBehavior);
    $("reset-behavior").addEventListener("click", resetBehavior);
    $("save-baidu").addEventListener("click", saveBaidu);
    $("reset-baidu").addEventListener("click", resetBaidu);
    $("save-google").addEventListener("click", saveGoogle);
    $("reset-google").addEventListener("click", resetGoogle);
  });
})();
