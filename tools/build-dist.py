#!/usr/bin/env python3
# tools/build-dist.py -- 打包发布用 zip (extension/ + host/)
# 排除: 日志文件、Windows 保留设备名文件(nul/con/...)、__pycache__、临时文件
import os, zipfile, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web-to-openapi-dist.zip")
INCLUDE_DIRS = ["extension", "host"]
RESERVED = {"nul", "con", "prn", "aux"} | {f"com{i}" for i in range(1, 10)} | {f"lpt{i}" for i in range(1, 10)}

def skip(name):
    base = name.split(".")[0].lower()
    if base in RESERVED:
        return True
    if name.endswith(".log") or name.endswith(".tmp"):
        return True
    if name == "__pycache__" or name == ".DS_Store":
        return True
    return False

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
                    z.write(full, rel)
                    count += 1
    size = os.path.getsize(OUT)
    print(f"[dist] {OUT}")
    print(f"[dist] {count} files, {size/1024/1024:.1f} MB")

if __name__ == "__main__":
    main()
