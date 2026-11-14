"use strict";
/*
 * 页面内探针脚本(v1.8.0)
 * ---------------------------------------------------------------------------
 * 这些字符串经 chrome_javascript 注入页面主世界执行(Runtime.evaluate + awaitPromise)。
 * 设计约束(踩过的坑):
 *   1) 必须 return 可 JSON 序列化对象; 返回超长字符串会被扩展侧 sanitize 截断
 *   2) 不要回完整 URL / 页面全文 —— 只回 path、title、URL 哈希(判变化够用)
 *   3) 状态一律挂 window.__w2o_* 上跨调用复用, 不依赖 host 侧存元素引用
 *
 * 与扩展自带 ref 体系的区别(为什么不用 ref_N):
 *   扩展的 ref 是页面内 ++__claudeRefCounter 生成的, 无 epoch、无文档标识 ——
 *   刷新后 ref_5 会指向新文档里的另一个元素, 而且报错只说 element not found。
 *   这里改成 "<pageToken>.r<seq>": pageToken 在每份文档首次注入时生成, 刷新即变,
 *   所以旧 ref 一定对不上 token, 能明确报 DOCUMENT_CHANGED 而不是含糊的找不到。
 */

// 前置: token / MutationObserver / 注册表。幂等, 重复注入不重建。
const PRELUDE = `
if(!window.__w2o){
  window.__w2o = { tok:null, seq:0, mut:0, refs:Object.create(null), byEl:new WeakMap(), obs:null };
}
if(!window.__w2o.tok){
  window.__w2o.tok = 'p' + (Date.now() % 46656).toString(36) + Math.random().toString(36).slice(2,4);
}
if(!window.__w2o.obs && typeof MutationObserver === 'function'){
  try{
    window.__w2o.obs = new MutationObserver(function(ms){ window.__w2o.mut += ms.length; });
    window.__w2o.obs.observe(document.documentElement || document, {
      childList:true, subtree:true, attributes:true, characterData:true
    });
  }catch(e){}
}
`;

// 公共辅助函数
const HELPERS = `
function w2oVisible(el){
  if(!el || !el.isConnected) return false;
  var r = el.getBoundingClientRect();
  if(r.width <= 0 || r.height <= 0) return false;
  var cs;
  try{ cs = getComputedStyle(el); }catch(e){ return false; }
  if(cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
  return true;
}
function w2oText(el, max){
  var s = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '';
  if(!s){
    var t = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    s = t;
  }
  if(!s && el.value) s = String(el.value);
  return String(s || '').slice(0, max || 40);
}
function w2oRole(el){
  var r = el.getAttribute('role');
  if(r) return r;
  var t = el.tagName.toLowerCase();
  if(t === 'a') return 'link';
  if(t === 'button') return 'button';
  if(t === 'select') return 'combobox';
  if(t === 'textarea') return 'textbox';
  if(t === 'input'){
    var ty = (el.type || 'text').toLowerCase();
    if(ty === 'checkbox') return 'checkbox';
    if(ty === 'radio') return 'radio';
    if(ty === 'submit' || ty === 'button') return 'button';
    return 'textbox';
  }
  return t;
}
// 关联 <label> 文本(语义定位用): 优先原生 labels, 再 label[for=id], 再包裹的 label
function w2oLabel(el){
  var s = '';
  try{
    if(el.labels && el.labels.length){
      s = (el.labels[0].innerText || el.labels[0].textContent || '').replace(/\\s+/g,' ').trim();
    }
  }catch(e){}
  if(!s && el.id){
    try{
      var l = document.querySelector('label[for="' + el.id + '"]');
      if(l) s = (l.innerText || l.textContent || '').replace(/\\s+/g,' ').trim();
    }catch(e){}
  }
  if(!s && el.closest){
    try{
      var p = el.closest('label');
      if(p) s = (p.innerText || p.textContent || '').replace(/\\s+/g,' ').trim();
    }catch(e){}
  }
  return s ? s.slice(0, 40) : null;
}
function w2oCenter(el){
  var r = el.getBoundingClientRect();
  return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
}
// 遮挡判定: elementFromPoint 命中的是不是目标本身(或它的子孙)
function w2oHit(el, cx, cy){
  try{
    var h = document.elementFromPoint(cx, cy);
    if(!h) return 'none';
    if(h === el) return 'self';
    if(el.contains(h)) return 'descendant';
    var cls = (typeof h.className === 'string' && h.className.trim()) ? '.' + h.className.trim().split(/\\s+/)[0] : '';
    return 'overlay:' + h.tagName.toLowerCase() + cls;
  }catch(e){ return 'unknown'; }
}
function w2oInView(el){
  var r = el.getBoundingClientRect();
  return r.top >= -1 && r.left >= -1 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1;
}
function w2oUrlHash(){
  var s = String(location.href);
  var h = 5381;
  for(var i = 0; i < s.length; i++){ h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; }
  return h;
}
function w2oSnap(){
  return {
    uh: w2oUrlHash(),
    path: String(location.pathname || '').slice(0, 120),
    title: String(document.title || '').slice(0, 60),
    mut: window.__w2o.mut,
    focus: window.__w2o.byEl.get(document.activeElement) || null,
    ready: document.readyState
  };
}
// 目标元素的"值状态"——只回长度和掩码, 不回明文(输入框里可能是密码/手机号)
function w2oVal(el){
  if(!el) return null;
  var v = null;
  if(typeof el.value === 'string') v = { len: el.value.length, head: el.value.slice(0, 3) };
  return {
    value: v,
    checked: (typeof el.checked === 'boolean') ? el.checked : null,
    disabled: !!el.disabled
  };
}
function w2oFind(ref){
  var w = window.__w2o.refs[ref];
  if(!w || typeof w.deref !== 'function') return null;
  var el = w.deref();
  if(!el) return null;
  return el;
}
`;

/*
 * OBSERVE: 观察页面, 分配/复用 ref, 返回元素清单。
 * 参数: MAXN(数量上限) 由调用方拼进脚本。
 */
function observeScript(maxN) {
  return `${PRELUDE}${HELPERS}
var SEL = 'a[href],button,input,select,textarea,summary,' +
  '[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=option],' +
  '[onclick],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
var all = [];
try{ all = Array.prototype.slice.call(document.querySelectorAll(SEL)); }catch(e){}
var out = [];
var limit = ${Math.max(1, Math.floor(maxN || 120))};
for(var i = 0; i < all.length && out.length < limit; i++){
  var el = all[i];
  if(!w2oVisible(el)) continue;
  var ref = window.__w2o.byEl.get(el);
  if(!ref){
    ref = window.__w2o.tok + '.r' + (++window.__w2o.seq);
    try{ window.__w2o.byEl.set(el, ref); }catch(e){}
    try{ window.__w2o.refs[ref] = new WeakRef(el); }catch(e){}
  }
  var c = w2oCenter(el);
  var hit = w2oHit(el, c.cx, c.cy);
  out.push({
    ref: ref,
    tag: el.tagName.toLowerCase(),
    role: w2oRole(el),
    name: w2oText(el, 40),
    type: el.type || null,
    label: w2oLabel(el),
    placeholder: el.getAttribute('placeholder') || null,
    id: el.id || null,
    name_attr: el.getAttribute('name') || null,
    disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
    rect: { x: Math.round(el.getBoundingClientRect().left), y: Math.round(el.getBoundingClientRect().top), cx: c.cx, cy: c.cy },
    hit: hit,
    in_view: w2oInView(el)
  });
}
return {
  tok: window.__w2o.tok,
  state: w2oSnap(),
  scanned: all.length,
  shown: out.length,
  truncated: all.length > out.length,
  elements: out
};
`;
}

/*
 * RESOLVE: 点击/输入前的门禁。校验 token、元素存活、可见、遮挡, 并采基线。
 * params: ref, wantTok, quietMs(静默采样窗口, 默认 300)
 * 返回值 stale 非空即拒绝派发。
 */
function resolveScript(ref, wantTok, quietMs) {
  const q = Math.max(0, Math.floor(quietMs == null ? 300 : quietMs));
  return `${PRELUDE}${HELPERS}
var REF = ${JSON.stringify(String(ref || ""))};
var WANT = ${JSON.stringify(String(wantTok || ""))};
var curTok = window.__w2o.tok;
if(!WANT) return { stale:'REF_NOT_PRESENTED', tok:curTok, why:'调用方没有先 observe, 不知道本页 token' };
if(curTok !== WANT) return { stale:'DOCUMENT_CHANGED', tok:curTok, why:'页面已重新加载或更换文档, 旧 ref 全部失效, 请重新 observe' };
if(!Object.prototype.hasOwnProperty.call(window.__w2o.refs, REF)) return { stale:'REF_NOT_PRESENTED', tok:curTok, why:'该 ref 不在本页观察集合里(未 observe 过或已失效)' };
var el = w2oFind(REF);
if(!el) return { stale:'FRAME_DETACHED', tok:curTok, why:'元素已被移除或 iframe 已卸载' };
var c = w2oCenter(el);
var hit = w2oHit(el, c.cx, c.cy);
if(!w2oVisible(el)) return { stale:'NOT_VISIBLE', tok:curTok, hit:hit, why:'元素不可见(尺寸为 0 或 display/visibility 隐藏)' };
if(hit !== 'self' && hit !== 'descendant') return { stale:'OBSCURED', tok:curTok, hit:hit, cx:c.cx, cy:c.cy, why:'目标被其他元素遮挡, 直接点会打到遮挡层' };
if(el.disabled || el.getAttribute('aria-disabled') === 'true') return { stale:'DISABLED', tok:curTok, hit:hit, why:'元素处于禁用态' };
var before = w2oSnap();
var base = w2oVal(el);
var m0 = window.__w2o.mut;
${q > 0 ? `await new Promise(function(r){ setTimeout(r, ${q}); });` : ""}
var quiet = window.__w2o.mut - m0;
return {
  stale: null,
  tok: curTok,
  quiet: quiet,
  target: {
    ref: REF,
    tag: el.tagName.toLowerCase(),
    role: w2oRole(el),
    name: w2oText(el, 40),
    type: el.type || null,
    cx: c.cx,
    cy: c.cy,
    hit: hit,
    in_view: w2oInView(el),
    rect: { x: Math.round(el.getBoundingClientRect().left), y: Math.round(el.getBoundingClientRect().top) }
  },
  before: before,
  base: base
};
`;
}

/*
 * SETTLE: 派发后取证。轮询直到出现强信号或超时。
 * params: ref, base(resolve 返回的 before/base), expect(数组), maxMs
 * 返回 verdict: changed / weak / none
 *   strong 信号: URL 变、焦点转移、值变、勾选变、目标消失(且 expect 要求 gone)
 *   weak   信号: 只有 DOM mutation 增长(不能断言是本次动作造成的)
 */
function settleScript(ref, base, expect, maxMs) {
  const want = Math.max(200, Math.floor(maxMs == null ? 1500 : maxMs));
  return `${PRELUDE}${HELPERS}
var REF = ${JSON.stringify(String(ref || ""))};
var BASE = ${JSON.stringify(base || {})};
var EXPECT = ${JSON.stringify(expect || [])};
var LIMIT = ${want};
var t0 = performance.now();

function cur(){
  var el = w2oFind(REF);
  return { s: w2oSnap(), v: w2oVal(el), alive: !!el };
}
function strong(b, c){
  if(c.s.uh !== b.uh) return 'url_changed';
  if(c.s.focus !== b.focus && c.s.focus) return 'focus_moved';
  if(c.v && b.base){
    var bv = b.base.value, cv = c.v.value;
    if(bv && cv && bv.len !== cv.len) return 'value_changed';
    if(bv && cv && bv.head !== cv.head) return 'value_changed';
    if(c.v.checked !== b.base.checked) return 'checked_changed';
  }
  return null;
}
function checkExpect(c){
  var checks = [];
  for(var i = 0; i < EXPECT.length; i++){
    var e = EXPECT[i] || {};
    var ok = true;
    if(e.expect === 'url') ok = String(location.href).indexOf(String(e.value)) >= 0;
    else if(e.expect === 'text') ok = String(document.body ? document.body.innerText : '').indexOf(String(e.value)) >= 0;
    else if(e.expect === 'value') ok = !!(c.v && c.v.value && (c.v.value.head === '') ? false : !!c.v);
    else if(e.expect === 'checked') ok = !!(c.v && c.v.checked === !!e.value);
    else if(e.expect === 'gone') ok = !c.alive;
    else ok = false;
    checks.push({ expect: e.expect, value: e.value, ok: ok });
  }
  return checks;
}

var first = cur();
var sig = strong(BASE, first);
var hasExpect = EXPECT.length > 0;
if(!sig && hasExpect){
  var ck0 = checkExpect(first);
  var allOk0 = ck0.every(function(x){ return x.ok; });
  if(allOk0) sig = 'expect_met';
}
if(sig){
  return { verdict:'changed', signal:sig, elapsed_ms: Math.round(performance.now() - t0),
           after: first.s, checks: hasExpect ? checkExpect(first) : [], alive: first.alive };
}
while(performance.now() - t0 < LIMIT){
  await new Promise(function(r){ setTimeout(r, 100); });
  var c = cur();
  var s2 = strong(BASE, c);
  if(!s2 && hasExpect){
    var ck = checkExpect(c);
    if(ck.every(function(x){ return x.ok; })) s2 = 'expect_met';
  }
  if(s2){
    return { verdict:'changed', signal:s2, elapsed_ms: Math.round(performance.now() - t0),
             after: c.s, checks: hasExpect ? checkExpect(c) : [], alive: c.alive };
  }
}
var last = cur();
var grew = last.s.mut - (BASE.mut || 0);
return {
  verdict: grew > 0 ? 'weak' : 'none',
  signal: grew > 0 ? 'mutations:' + grew : null,
  elapsed_ms: Math.round(performance.now() - t0),
  after: last.s,
  checks: hasExpect ? checkExpect(last) : [],
  alive: last.alive
};
`;
}

/*
 * FIND: 按语义字段在已观察集合里查找, 返回匹配 ref 列表(含识别信息)。
 * filters: [{field, value, op}], field ∈ text/name/label/placeholder/id/role/tag/type
 *   op: contains(默认) / equals / starts_with
 * 只查 observe 登记过的元素(known-set 不变量), 不跨过 observe 直接定位新元素。
 */
function findScript(filters, maxN) {
  const limit = Math.max(1, Math.floor(maxN || 50));
  return `${PRELUDE}${HELPERS}
var FILTERS = ${JSON.stringify(filters || [])};
var MAXN = ${limit};
function recOf(el, ref){
  var c = w2oCenter(el);
  return {
    ref: ref,
    tag: el.tagName.toLowerCase(),
    role: w2oRole(el),
    name: w2oText(el, 40),
    type: el.type || null,
    label: w2oLabel(el),
    placeholder: el.getAttribute('placeholder') || null,
    id: el.id || null,
    name_attr: el.getAttribute('name') || null,
    disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
    cx: c.cx,
    cy: c.cy
  };
}
function fieldOf(rec, field){
  if(field === 'text') return rec.name;
  if(field === 'name') return rec.name_attr;
  if(field === 'label') return rec.label;
  if(field === 'placeholder') return rec.placeholder;
  if(field === 'id') return rec.id;
  if(field === 'role') return rec.role;
  if(field === 'tag') return rec.tag;
  if(field === 'type') return rec.type;
  return null;
}
var keys = Object.keys(window.__w2o.refs);
var matches = [];
for(var i = 0; i < keys.length && matches.length < MAXN; i++){
  var el = w2oFind(keys[i]);
  if(!el || !w2oVisible(el)) continue;
  var rec = recOf(el, keys[i]);
  var ok = true;
  for(var j = 0; j < FILTERS.length; j++){
    var f = FILTERS[j] || {};
    var actual = String(fieldOf(rec, f.field) || '');
    var want = String(f.value == null ? '' : f.value);
    var op = f.op || 'contains';
    var hit = false;
    if(op === 'equals') hit = actual === want;
    else if(op === 'starts_with') hit = actual.indexOf(want) === 0;
    else hit = actual.indexOf(want) >= 0;
    if(!hit){ ok = false; break; }
  }
  if(ok) matches.push(rec);
}
return { tok: window.__w2o.tok, count: matches.length, truncated: matches.length >= MAXN, matches: matches };
`;
}

/*
 * NATIVE SELECT: 原生 <select> 设值。JS 设 value + 派发 change/input 事件(非受信点击)。
 * 仅用于 <select> 快速路径; 自定义下拉(div 模拟)走 click + find + click 组合(见 action.select)。
 * value 同时匹配 option 的 value 与显示文本(去空白)。
 */
function nativeSelectScript(ref, value) {
  return `${PRELUDE}${HELPERS}
var REF = ${JSON.stringify(String(ref || ""))};
var VALUE = ${JSON.stringify(String(value == null ? "" : value))};
var el = w2oFind(REF);
if(!el) return { ok:false, why:'element_gone' };
if(el.tagName.toLowerCase() !== 'select') return { ok:false, why:'not_a_native_select', tag:el.tagName.toLowerCase() };
var opts = Array.prototype.slice.call(el.options || []);
var found = null;
for(var i = 0; i < opts.length; i++){
  var oi = opts[i];
  if(String(oi.value) === VALUE || String(oi.text).replace(/\\s+/g,' ').trim() === VALUE){ found = oi; break; }
}
if(!found) return { ok:false, why:'option_not_found', available: opts.map(function(x){ return { value: x.value, text: String(x.text).replace(/\\s+/g,' ').trim() }; }).slice(0, 50) };
var before = el.value;
el.value = found.value;
try{ el.dispatchEvent(new Event('change', { bubbles: true })); }catch(e){}
try{ el.dispatchEvent(new Event('input', { bubbles: true })); }catch(e){}
return { ok:true, kind:'native', before: before, value: el.value, text: String(found.text).replace(/\\s+/g,' ').trim() };
`;
}

module.exports = { observeScript, resolveScript, settleScript, findScript, nativeSelectScript };