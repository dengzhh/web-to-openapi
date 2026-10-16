// tools/gen-key.mjs —— 生成扩展专属 RSA 密钥，计算 Chromium 扩展 ID，并可选择就地写回配置。
//
// 什么时候需要跑它?
//   仓库里已随附一枚固定公钥(manifest.json 的 key 字段), 扩展 ID 固定为
//   bjgdikingllkajknbjlopfmhgpcjponf, native host manifest 的 allowed_origins 也指向它,
//   开箱即用, 通常不需要动。只有在你想换一个自己的扩展 ID 时才跑本脚本。
//
// 用法:
//   node tools/gen-key.mjs              # 只生成密钥并打印 ID
//   node tools/gen-key.mjs --apply      # 同时写入 extension/manifest.json 与 native host manifest
//   node tools/gen-key.mjs <输出目录>    # 自定义密钥文件输出位置(默认 host/)
//
// 产出: <输出目录>/extension-key.json { id, key, privateKeyPem }
//   - key(公钥)  : 写入 extension/manifest.json 的 key 字段, 决定扩展 ID
//   - privateKeyPem(私钥): 仅本地保存, 已在 .gitignore 中排除, 切勿提交/分发
//
// 流程: 生成 -> --apply 写回两处 -> 双击 host/install.bat 重新注册 -> 重新加载扩展
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const outDirArg = args.find((a) => !a.startsWith("--"));
const outDir = path.resolve(outDirArg || path.join(root, "host"));

// Chromium 扩展 ID 算法(实证校准过):
//   sha256(公钥 DER) -> 取前 16 字节 -> hex(32 字符) -> 每个 hex 字符 c 映射为 'a'+val(c)
// 无 key 的已解包扩展走另一条路: 规范化绝对路径的 UTF-16LE(Windows), 路径一变 ID 就变,
// 这正是必须在 manifest 里写死 key 的原因 —— native messaging 需要稳定的 ID。
function extIdFromDer(der) {
  const h = crypto.createHash("sha256").update(der).digest().subarray(0, 16);
  return Array.from(h.toString("hex"))
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join("");
}

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "der" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const keyB64 = publicKey.toString("base64");
const id = extIdFromDer(publicKey);

fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "extension-key.json");
fs.writeFileSync(
  outFile,
  JSON.stringify(
    {
      note: "key(公钥) 写入 extension/manifest.json; id 写入 native host manifest 的 allowed_origins。privateKeyPem 为私钥, 切勿提交或分发。",
      id,
      key: keyB64,
      privateKeyPem: privateKey,
    },
    null,
    2
  ),
  "utf8"
);
console.log("[gen] new extension id:", id);
console.log("[gen] saved:", outFile);

if (!apply) {
  console.log("[next] 加 --apply 可自动写回两处配置; 或手动改:");
  console.log(`       1) extension/manifest.json 的 key -> ${keyB64.slice(0, 24)}...`);
  console.log(`       2) host/com.webtoopenapi.host.json 的 allowed_origins -> chrome-extension://${id}/`);
  console.log("       然后双击 host/install.bat 重新注册。");
} else {
  // 1) 扩展 manifest: 覆盖 key 字段(保留其它字段原样)
  const extManifest = path.join(root, "extension", "manifest.json");
  const m = JSON.parse(fs.readFileSync(extManifest, "utf8"));
  m.key = keyB64;
  fs.writeFileSync(extManifest, JSON.stringify(m, null, 2), "utf8");
  console.log("[apply] extension/manifest.json key updated");

  // 2) native host manifest: allowed_origins 换成新 ID
  const hostManifest = path.join(root, "host", "com.webtoopenapi.host.json");
  const h = JSON.parse(fs.readFileSync(hostManifest, "utf8").replace(/^﻿/, ""));
  h.allowed_origins = [`chrome-extension://${id}/`];
  fs.writeFileSync(hostManifest, JSON.stringify(h, null, 2), "utf8");
  console.log("[apply] host/com.webtoopenapi.host.json allowed_origins ->", h.allowed_origins[0]);

  console.log("[next] 双击 host/install.bat 重新注册, 再在 edge://extensions 重新加载扩展。");
}
