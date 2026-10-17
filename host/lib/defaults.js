"use strict";
/*
 * 站点默认参数的通用存储: 三层合并(请求参数 > 扩展设置页下发 > 内置默认)。
 * 持久化在 %LOCALAPPDATA%\webtoopenapi\<file>, host 重启不丢。
 * 扩展侧通过 native messaging 下发(set/get_<nmType>_defaults), 见 registry.handleNm。
 */
const fs = require("fs");
const path = require("path");
const { STATE_DIR } = require("./config");
const { log } = require("./log");

function createDefaultsStore(opts) {
  const { id, file, builtin, sanitize } = opts;
  const nmType = opts.nmType || id;
  const stateFile = path.join(STATE_DIR, "webtoopenapi", file);
  let stored = { ...builtin };

  function load() {
    try {
      const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (saved && typeof saved === "object") stored = { ...builtin, ...saved };
    } catch (e) { /* 无文件或损坏: 保持内置默认 */ }
    return stored;
  }

  function save() {
    try { fs.writeFileSync(stateFile, JSON.stringify(stored, null, 2), "utf8"); }
    catch (e) { log("warn", `save ${id} defaults failed: ${e.message}`); }
  }

  // 白名单清洗 + 落盘 + 内存生效
  function set(input) {
    stored = { ...builtin, ...sanitize(input) };
    save();
    log("info", `${id} defaults updated: ${JSON.stringify(stored)}`);
    return stored;
  }

  return {
    id, nmType, builtin, stateFile,
    load, save, set,
    get: () => stored,
    effective: () => ({ ...builtin, ...stored }),
    sanitize,
  };
}

module.exports = { createDefaultsStore };
