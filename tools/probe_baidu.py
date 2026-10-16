# -*- coding: utf-8 -*-
"""百度 SERP 探针 v2: 支持 --tab 复用标签页 / 自定义 JS。"""
import json, sys, time
import requests

BASE = "http://127.0.0.1:8090"

def tool(name, args, timeout=90):
    r = requests.post(f"{BASE}/api/v1/tools/{name}", json={"args": args}, timeout=timeout)
    r.raise_for_status()
    body = r.json()
    res = body.get("result", body)
    if isinstance(res, dict) and res.get("isError"):
        raise RuntimeError(res.get("content"))
    content = res.get("content") if isinstance(res, dict) else res
    if isinstance(content, list):
        text = "\n".join(c.get("text", "") for c in content if isinstance(c, dict))
    else:
        text = json.dumps(content, ensure_ascii=False)
    try:
        return json.loads(text)
    except Exception:
        return text

def run_js(tab_id, code, tries=3):
    last = None
    for _ in range(tries):
        d = tool("chrome_javascript", {"tabId": tab_id, "code": code, "timeoutMs": 15000})
        inner = d.get("result", d) if isinstance(d, dict) else d
        if isinstance(inner, str):
            try: inner = json.loads(inner)
            except Exception: pass
        last = inner
        if inner:
            return inner
        time.sleep(2)
    return last

args = sys.argv[1:]
if args and args[0] == "--tab":
    tab_id = int(args[1]); args = args[2:]
    if args:
        # 自定义 JS 文件
        code = open(args[0], encoding="utf-8").read()
        print(json.dumps(run_js(tab_id, code), ensure_ascii=False, indent=1)[:6000])
    else:
        print("need js file")
    sys.exit(0)

url = args[0]
nav = tool("chrome_navigate", {"url": url, "newWindow": True, "background": False, "width": 1280, "height": 900})
tabs = nav.get("tabs") or []
tab_id = tabs[0]["tabId"] if tabs else nav.get("tabId")
print("NAV tab:", tab_id, "|", url)
time.sleep(3)
code = """
const bodyText=document.body.innerText||'';
const timeHints=[...document.querySelectorAll('[class*="time"],[class*="tool"]')].map(e=>(e.innerText||'').trim()).filter(t=>t&&t.length<40&&/天|周|年|时间/.test(t)).slice(0,12);
return JSON.stringify({
  title:document.title,
  realCount:document.querySelectorAll('.result:not(.result-op)').length,
  nums:(document.body.innerText.match(/找到相关结果[^\\n]*/)||[''])[0],
  verify:/百度安全验证|安全验证/.test(bodyText),
  timeHints:timeHints,
  hasDayChip:/一天内/.test(bodyText),
  hasWeekChip:/一周内/.test(bodyText)
});
"""
print(json.dumps(run_js(tab_id, code), ensure_ascii=False, indent=1)[:3000])
