"use strict";
/*
 * 日志: stdout 被 native messaging 协议帧独占, 所以日志只走 stderr + 文件。
 */
const fs = require("fs");
const path = require("path");
const { HOST_DIR } = require("./config");

const LOG_DIR = process.env.WEBTOOPENAPI_LOG_DIR || path.join(process.env.LOCALAPPDATA || HOST_DIR, "webtoopenapi", "logs");
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { /* ignore */ }
const LOG_FILE = path.join(LOG_DIR, "openapi-host.log");

function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  try { process.stderr.write(line + "\n"); } catch (e) { /* ignore */ }
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (e) { /* ignore */ }
}

module.exports = { log, LOG_DIR, LOG_FILE };
