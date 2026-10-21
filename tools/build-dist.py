#!/usr/bin/env python3
# tools/build-dist.py -- 打包发布用 zip (extension/ + host/)
# 排除: 日志文件、Windows 保留设备名文件(nul/con/...)、__pycache__、临时文件、扩展私钥
import os, zipfile, sys, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web-to-openapi-dist.zip")
INCLUDE_DIRS = ["extension", "host"]
INCLUDE_FILES = ["README.md", "API.md", "TROUBLESHOOTING.md"]  # 新机器安装指引 + 接口 + 排障 随包走
RESERVED = {"nul", "con", "prn", "aux"} | {f"com{i}" for i in range(1, 10)} | {f"lpt{i}" for i in range(1, 10)}

# 发布包里不写本机绝对路径: 换成占位符, install-host.ps1 运行时自愈成真实路径
MANIFEST_REL = os.path.join("host", "com.webtoopenapi.host.json")
PLACEHOLDER_PATH = rb"C:\\path\\to\\web-to-openapi\\host\\run_host.bat"


def skip(name):
    base = name.split(".")[0].lower()
    if base in RESERVED:
        return True
    # 扩展私钥绝不能进分发包(也不能进仓库); 用户自己生成 key 时 install-host.ps1 会推导 ID
    if name == "extension-key.json":
        return True
    if name.endswith(".log") or name.endswith(".tmp"):
        return True
    if name == "__pycache__" or name == ".DS_Store":
        return True
    return False


def manifest_bytes(path):
    """读清单 -> 去 BOM + 路径占位符化, 保证分发包在任何机器上都干净可用。"""
    raw = open(path, "rb").read()
    if raw[:3] == b"\xef\xbb\xbf":
        raw = raw[3:]
    raw, n = re.subn(rb'("path":\s*")([^"]*)(")',
                     lambda m: m.group(1) + PLACEHOLDER_PATH + m.group(3), raw, count=1)
    if n != 1:
        print("[warn] manifest path field not rewritten:", path)
    return raw


def main():
    if os.path.exists(OUT):
        os.remove(OUT)
    count = 0
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        for d in INCLUDE_DIRS:
            base = os.path.join(ROOT, d)
            for root, dirs, files in os.walk(base):
                dirs[:] = [x for x in dirs if not skip(x)]
                for f in files:
                    if skip(f):
                        continue
                    full = os.path.join(root, f)
                    rel = os.path.relpath(full, ROOT)
                    if rel == MANIFEST_REL:
                        z.writestr(rel, manifest_bytes(full))
                    else:
                        z.write(full, rel)
                    count += 1
        for f in INCLUDE_FILES:
            full = os.path.join(ROOT, f)
            if os.path.isfile(full):
                z.write(full, f)
                count += 1
    size = os.path.getsize(OUT)
    print(f"[dist] {OUT}")
    print(f"[dist] {count} files, {size/1024/1024:.1f} MB")

if __name__ == "__main__":
    main()
