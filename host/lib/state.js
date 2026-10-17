"use strict";
/*
 * 进程内共享的运行时状态。单独成文件是为了打破循环依赖:
 * http.js 写入端口/启动时间, 其它模块(spec/docs/service 工具)只读, 彼此不互相 require。
 */
const state = {
  httpPort: null,
  startedAt: null,
  listenUrl: () => `http://${require("./config").CONFIG.host}:${state.httpPort || require("./config").CONFIG.port}`,
};

module.exports = state;
