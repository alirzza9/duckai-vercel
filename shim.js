// shim-test.js v2 — minimal DOM shim for the duck.ai JS anti-abuse challenge.
// NO jsdom, NO real DOM, NO browser. Plain Node.js only.
//
// DESIGN (and how it maps to a Cloudflare Worker):
// The challenge is run inside a fresh JS realm whose GLOBAL OBJECT *is* the
// fake `window` (Node `vm.createContext(W)`). In a Worker the same shape is:
// attach the fakes to `globalThis` (`globalThis.window = globalThis`, ...)
// and `eval(challengeSrc)` — the Worker global plays the role of `window`.
// That shape is REQUIRED, not optional: challenge variant D (see below)
// probes `window.parseInt`, `Object.prototype.toString.call(window)` and
// sloppy-mode `this === window`, which only hold when window IS the global.
// A bare-object `window` (v1 design) hard-crashes variant D.
//
// What the challenges touch (deobfuscated; see *.deob.js / probe notes):
//   Variant A (2026-11-09 11:30): navigator.userAgent/webdriver;
//     document.createElement('div'), el.innerHTML (set+get),
//     el.querySelectorAll('*'); iframe srcdoc + contentWindow.self.get;
//     window.top / Object.keys(window.top).
//   Variant B (11:33, rotates per request): LAYOUT probe instead of innerHTML:
//     el.style.cssText, el.textContent, body.appendChild/removeChild,
//     el.offsetWidth/offsetHeight, el.getBoundingClientRect(),
//     getComputedStyle(el).getPropertyValue('display'), el.scrollHeight.
//     Same webdriver/iframe/window.top probe as A.
//   Variant D (12:0x, "integrity" probe): window.parseInt.toString()
//     .includes('[native code]'); subclass-of-Array map instanceof;
//     Object.prototype.toString.call(window) === '[object Window]';
//     new Error() instanceof Error; Error.captureStackTrace;
//     Object.isSealed(Math); sloppy this === window;
//     document.body.children (LIVE length); document.querySelectorAll('*')
//     is a NodeList (not Array, constructor.name === 'NodeList');
//     createElement('div') instanceof HTMLDivElement;
//     HTMLDivElement.prototype instanceof HTMLElement;
//     HTMLElement.prototype instanceof Element.
//     Same webdriver/iframe/window.top probe as A.
//   NOT touched by any variant seen: canvas, localStorage, screen, plugins,
//   fonts, WebGL, fetch/XHR, etc.
// (jsa_jsdom.js patches layout getters; variant B DOES read them — the shim
// provides the same fixed values 17/35/19 that the repo's runner uses.)
//
// Node-only parts of this harness: `vm` (realm) and `crypto` (SHA-256 for
// the proof). In a Worker, `vm` is replaced by the Worker global itself and
// SHA-256 by crypto.subtle.digest().
const fs = require('fs');
const crypto = require('crypto');
const vm = require('vm');

const UA = process.argv[3] ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

// ---------- tiny HTML fragment parser (enough for innerHTML round-trip) ----------
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);

function parseAttrs(s) {
  const attrs = [];
  const re = /([^\s"'`>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`>=]+)))?/g;
  let m;
  while ((m = re.exec(s))) attrs.push([m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '']);
  return attrs;
}

// Parses an HTML fragment into child nodes of `parent` (real element
// instances for tags, plain {tag:null,text} objects for text). Handles open /
// close / self-closing tags, attributes, text, void elements, an unterminated
// end-tag at EOF (dropped, per HTML5 "eof-in-tag"), and auto-close of
// still-open elements at EOF (fragment parsing).
function parseFragment(html, parent, makeEl) {
  const stack = [parent];
  let i = 0;
  const n = html.length;
  const addText = (t) => { if (t) stack[stack.length - 1].childNodes.push({ tag: null, text: t }); };
  while (i < n) {
    if (html[i] === '<') {
      const m = html.slice(i).match(/^<\/?[A-Za-z][^<>]*>/);
      if (!m) {
        if (/^<\/[A-Za-z]/.test(html.slice(i)) && !html.slice(i).includes('>')) break;
        addText('<'); i++; continue;
      }
      const tok = m[0];
      i += tok.length;
      const isClose = tok[1] === '/';
      const inner = tok.replace(/^<\/?|\/?>$/g, '');
      const sp = inner.search(/\s/);
      const name = (sp === -1 ? inner : inner.slice(0, sp)).toLowerCase();
      if (!name) continue;
      if (isClose) {
        for (let k = stack.length - 1; k >= 1; k--) {
          if (stack[k]._tag === name) { stack.length = k; break; }
        }
      } else {
        const el = makeEl(name);
        el._attrs = parseAttrs(sp === -1 ? '' : inner.slice(sp + 1));
        stack[stack.length - 1].childNodes.push(el);
        if (!VOID.has(name) && !tok.endsWith('/>')) stack.push(el);
      }
    } else {
      const j = html.indexOf('<', i);
      addText(html.slice(i, j === -1 ? n : j));
      i = j === -1 ? n : j;
    }
  }
}

function isEl(n) { return n instanceof Element; }
function escText(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function serialize(node) {
  if (!isEl(node)) return escText(node.text);
  const tag = node._tag;
  const attrs = (node._attrs || []).map(([k, v]) =>
    ` ${k}="${v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`).join('');
  if (VOID.has(tag)) return `<${tag}${attrs}>`;
  return `<${tag}${attrs}>${node.childNodes.map(serialize).join('')}</${tag}>`;
}

// ---------- fake CSSStyleDeclaration ----------
class FakeStyle {
  constructor() { this._map = new Map(); }
  _parse(cssText) {
    this._map.clear();
    for (const decl of String(cssText).split(';')) {
      const i = decl.indexOf(':');
      if (i === -1) continue;
      const k = decl.slice(0, i).trim().toLowerCase();
      const v = decl.slice(i + 1).trim();
      if (k) this._map.set(k, v);
    }
  }
  set cssText(v) { this._parse(v); }
  get cssText() {
    return [...this._map.entries()].map(([k, v]) => `${k}: ${v};`).join(' ');
  }
  getPropertyValue(name) { return this._map.get(String(name).toLowerCase()) ?? ''; }
  setProperty(name, value) { this._map.set(String(name).toLowerCase(), String(value)); }
  removeProperty(name) {
    const k = String(name).toLowerCase();
    const old = this._map.get(k) ?? '';
    this._map.delete(k);
    return old;
  }
}
function camelToDash(s) { return s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()); }
function makeStyle() {
  const st = new FakeStyle();
  return new Proxy(st, {
    get(t, p) {
      if (p in t) { const v = t[p]; return typeof v === 'function' ? v.bind(t) : v; }
      if (typeof p === 'string') return t.getPropertyValue(camelToDash(p));
      return undefined;
    },
    set(t, p, v) {
      if (p === 'cssText') { t.cssText = v; return true; }
      if (typeof p === 'string') { t.setProperty(camelToDash(p), v); return true; }
      return false;
    },
  });
}

const DISPLAY_DEFAULT = { div: 'block', p: 'block', body: 'block', span: 'inline',
  a: 'inline', iframe: 'inline', img: 'inline', input: 'inline-block', button: 'inline-block' };
function makeGetComputedStyle() {
  return function getComputedStyle(el) {
    return {
      getPropertyValue(name) {
        const k = String(name).toLowerCase();
        const inline = el && el.style ? el.style.getPropertyValue(k) : '';
        if (inline) return inline;
        if (k === 'display' && el) return DISPLAY_DEFAULT[el._tag] || 'block';
        return '';
      },
    };
  };
}

// ---------- live collections ----------
// HTMLCollection: `length` recomputes from the parent on every read, like a
// real browser's live collection (variant D holds the reference across an
// appendChild and re-reads .length).
class HTMLCollection {
  constructor(parent) { this._parent = parent; }
  get length() { return this._parent.childNodes.filter((c) => isEl(c)).length; }
  item(i) { return this._parent.childNodes.filter((c) => isEl(c))[i] ?? null; }
}
function liveCollection(parent) {
  const c = new HTMLCollection(parent);
  return new Proxy(c, {
    get(t, p) {
      if (p === 'length') return t.length;
      if (typeof p === 'string' && /^\d+$/.test(p)) return t.item(Number(p));
      const v = t[p];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}
// NodeList: array-like, but NOT an Array (Array.isArray === false) and with
// constructor.name === 'NodeList' — both are probed by variant D.
class NodeList {
  constructor(items) {
    this._items = items;
    for (let i = 0; i < items.length; i++) this[i] = items[i];
  }
  get length() { return this._items.length; }
  item(i) { return this._items[i] ?? null; }
  [Symbol.iterator]() { return this._items[Symbol.iterator](); }
}

// ---------- minimal selector matching (enough for the challenges) ----------
// Supports: '*', 'tag', '#id', 'tag[attr="value"]', 'tag[attr]', '[attr="value"]'.
// Real-DOM note: querySelector(All) on an Element searches descendants only.
function matchesSel(el, sel) {
  if (!isEl(el)) return false;
  sel = String(sel).trim();
  if (sel === '*') return true;
  let rest = sel;
  let tag = null;
  let id = null;
  let attrName = null;
  let attrVal = undefined;
  const hashIdx = rest.indexOf('#');
  const brIdx = rest.indexOf('[');
  if (hashIdx !== -1 && (brIdx === -1 || hashIdx < brIdx)) {
    tag = rest.slice(0, hashIdx) || null;
    const after = rest.slice(hashIdx + 1);
    const end = after.search(/[\[\s]/);
    id = end === -1 ? after : after.slice(0, end);
    rest = end === -1 ? '' : after.slice(end);
  } else if (brIdx !== -1) {
    tag = rest.slice(0, brIdx) || null;
    rest = rest.slice(brIdx);
  } else {
    tag = rest || null;
    rest = '';
  }
  if (rest.startsWith('[')) {
    const m = rest.match(/^\[\s*([^\s=\]]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+)))?\s*\]/);
    if (!m) return false;
    attrName = m[1].toLowerCase();
    attrVal = m[2] ?? m[3] ?? m[4];
  }
  if (tag && el._tag !== tag.toLowerCase()) return false;
  if (id !== null && id !== '' && el.id !== id) return false;
  if (attrName) {
    const v = el.getAttribute(attrName);
    if (v === null) return false;
    if (attrVal !== undefined && v !== attrVal) return false;
  }
  return true;
}
function collectMatches(nodes, sel, out) {
  for (const c of nodes) {
    if (!isEl(c)) continue;
    if (matchesSel(c, sel)) out.push(c);
    collectMatches(c.childNodes, sel, out);
  }
}
function findFirst(nodes, sel) {
  for (const c of nodes) {
    if (!isEl(c)) continue;
    if (matchesSel(c, sel)) return c;
    const hit = findFirst(c.childNodes, sel);
    if (hit) return hit;
  }
  return null;
}

// ---------- element classes (prototype chain probed by variant D) ----------
class Element {
  constructor(tag) {
    this._tag = String(tag).toLowerCase();
    this.tagName = this._tag.toUpperCase();
    this.childNodes = [];
    this._attrs = [];
    this._srcdoc = '';
    this.style = makeStyle();
    this._childrenCollection = null;
    this._contentDocument = null;
    if (this._tag === 'iframe') {
      const cw = {};
      cw.self = cw; // contentWindow.self.get === undefined, like a real iframe
      this._contentWindow = cw;
    }
  }
  get children() {
    if (!this._childrenCollection) this._childrenCollection = liveCollection(this);
    return this._childrenCollection;
  }
  set innerHTML(html) {
    this.childNodes = [];
    parseFragment(String(html), this, (t) => createElement(t));
  }
  get innerHTML() { return this.childNodes.map(serialize).join(''); }
  set textContent(v) { this.childNodes = v === '' ? [] : [{ tag: null, text: String(v) }]; }
  get textContent() {
    let out = '';
    const walk = (nodes) => { for (const c of nodes) { if (!isEl(c)) out += c.text; else walk(c.childNodes); } };
    walk(this.childNodes);
    return out;
  }
  querySelectorAll(sel) {
    if (sel !== '*') return new NodeList([]);
    const out = [];
    const walk = (nodes) => {
      for (const c of nodes) { if (isEl(c)) { out.push(c); walk(c.childNodes); } }
    };
    walk(this.childNodes);
    return new NodeList(out);
  }
  appendChild(el) { this.childNodes.push(el); return el; }
  removeChild(el) {
    const i = this.childNodes.indexOf(el);
    if (i !== -1) this.childNodes.splice(i, 1);
    return el;
  }
  getAttribute(name) {
    const n = String(name).toLowerCase();
    const a = (this._attrs || []).find(([k]) => k === n);
    return a ? a[1] : null;
  }
  setAttribute(name, value) {
    const n = String(name).toLowerCase();
    const a = (this._attrs || []).find(([k]) => k === n);
    if (a) a[1] = String(value);
    else (this._attrs = this._attrs || []).push([n, String(value)]);
  }
  removeAttribute(name) {
    const n = String(name).toLowerCase();
    this._attrs = (this._attrs || []).filter(([k]) => k !== n);
  }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get contentDocument() { return this._contentDocument || null; }
  set contentDocument(d) {
    this._contentDocument = d || null;
    if (this._contentWindow) this._contentWindow.document = d || undefined;
  }
  querySelector(sel) {
    return findFirst(this.childNodes, sel);
  }
  querySelectorAll(sel) {
    const out = [];
    collectMatches(this.childNodes, sel, out);
    return new NodeList(out);
  }
  get contentWindow() { return this._contentWindow; }
  set srcdoc(v) { this._srcdoc = String(v); }
  get srcdoc() { return this._srcdoc; }
  // Layout: same fixed values the repo's jsdom runner patches in.
  get offsetWidth() { return 17; }
  get offsetHeight() { return 35; }
  get scrollHeight() { return 19; }
  get clientWidth() { return 17; }
  get clientHeight() { return 35; }
  getBoundingClientRect() {
    return { width: 17, height: 35, top: 0, left: 0, right: 17, bottom: 35, x: 0, y: 0 };
  }
}
class HTMLElement extends Element {}
class HTMLDivElement extends HTMLElement {}
class HTMLIFrameElement extends HTMLElement {}
class HTMLBodyElement extends HTMLElement {}

function createElement(tag) {
  const t = String(tag).toLowerCase();
  if (t === 'div') return new HTMLDivElement(t);
  if (t === 'iframe') return new HTMLIFrameElement(t);
  if (t === 'body') return new HTMLBodyElement(t);
  return new HTMLElement(t);
}

// ---------- build the fake-window realm ----------
// opts: { beVersion, feHash } — duck.ai's entry script sets
// window.__DDG_BE_VERSION__ (data-version-tag) and window.__DDG_FE_CHAT_HASH__
// (data-version-sha) as own properties of window; variant E probes them with
// hasOwnProperty, so they must exist. The real page also renders an offscreen
// <iframe id="jsa" sandbox="allow-scripts allow-same-origin"> into body whose
// srcdoc document carries <meta http-equiv="Content-Security-Policy"
// content="default-src 'none'; script-src 'unsafe-inline';"> — variant E
// probes exactly that, so the shim seeds the same structure (verified against
// duck.ai's own entry.duckai.js, 2026-11-09). Without it the probe returns
// 1617 (missing element) instead of the real-browser 1621.
function makeRealm(opts) {
  opts = opts || {};
  const W = {}; // will become the realm global AND the fake window
  const navigator = {
    userAgent: UA,
    appVersion: UA.replace('Mozilla/', ''),
    webdriver: false,
  };
  const body = createElement('body');
  // Fake document for the #jsa iframe's srcdoc (CSP meta only — that is all
  // any challenge variant reads from it).
  const jsaHead = createElement('head');
  const jsaMeta = createElement('meta');
  jsaMeta.setAttribute('http-equiv', 'Content-Security-Policy');
  jsaMeta.setAttribute('content', "default-src 'none'; script-src 'unsafe-inline';");
  jsaHead.appendChild(jsaMeta);
  const jsaBody = createElement('body');
  const jsaDoc = {
    createElement: (tag) => createElement(tag),
    body: jsaBody,
    head: jsaHead,
    querySelector(sel) {
      return findFirst([jsaHead, jsaBody], sel);
    },
    querySelectorAll(sel) {
      const out = [];
      collectMatches([jsaHead, jsaBody], sel, out);
      return new NodeList(out);
    },
    getElementById(id) { return findFirst([jsaHead, jsaBody], '#' + id); },
  };
  const jsaFrame = createElement('iframe');
  jsaFrame.setAttribute('id', 'jsa');
  jsaFrame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  jsaFrame.setAttribute('srcdoc', '<!DOCTYPE html>\n<html>\n<head>\n<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\';">');
  jsaFrame.contentDocument = jsaDoc;
  body.appendChild(jsaFrame);
  const document = {
    createElement: (tag) => createElement(tag),
    body,
    querySelector(sel) {
      return findFirst([body], sel);
    },
    querySelectorAll(sel) {
      if (sel !== '*') {
        const out = [];
        collectMatches([body], sel, out);
        return new NodeList(out);
      }
      const out = [body];
      const walk = (nodes) => {
        for (const c of nodes) { if (isEl(c)) { out.push(c); walk(c.childNodes); } }
      };
      walk(body.childNodes);
      return new NodeList(out);
    },
    getElementById(id) { return findFirst([body], '#' + id); },
  };
  W.window = W;
  W.self = W;
  W.top = W;
  W.document = document;
  W.navigator = navigator;
  W.__DDG_BE_VERSION__ = opts.beVersion || 'dev';
  W.__DDG_FE_CHAT_HASH__ = opts.feHash || 'hash';
  W.getComputedStyle = makeGetComputedStyle();
  W.Element = Element;
  W.HTMLElement = HTMLElement;
  W.HTMLDivElement = HTMLDivElement;
  W.HTMLIFrameElement = HTMLIFrameElement;
  W.HTMLBodyElement = HTMLBodyElement;
  W.NodeList = NodeList;
  W.HTMLCollection = HTMLCollection;
  // Object.prototype.toString.call(window) === '[object Window]'
  Object.defineProperty(W, Symbol.toStringTag, { value: 'Window', configurable: true });
  vm.createContext(W); // W is now a full JS realm global; intrinsics (parseInt,
  // Array, Promise, JSON, Math, Error, ...) live on it, like window.* in a browser
  return W;
}

// Run the challenge in the fake-window realm. The returned value is the
// challenge's async-IIFE promise; awaiting a foreign-realm thenable works.
async function solveChallenge(src, opts) {
  const W = makeRealm(opts);
  const result = await vm.runInContext(src, W);
  return result;
}

// ---------- proof (mirrors DuckAI.build_proof in duck_cli.py) ----------
function sha256_b64(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest().toString('base64');
}
function buildProof(solved) {
  const proof = { ...solved };
  proof.client_hashes = solved.client_hashes.map(sha256_b64);
  const meta = { ...(solved.meta || {}) };
  meta.origin = 'https://duck.ai';
  meta.stack = 'Error\nat l (https://duck.ai/dist/duckai-dist/entry.duckai.js:2:2129171)\n'
    + 'at async https://duck.ai/dist/duckai-dist/entry.duckai.js:2:1859809';
  meta.duration = '58';
  proof.meta = meta;
  return Buffer.from(JSON.stringify(proof)).toString('base64');
}

(async () => {
  if (require.main !== module) return;
  const srcFile = process.argv[2] || 'challenge-2026-11-09.js';
  const src = fs.readFileSync(srcFile, 'utf8');
  const t0 = Date.now();
  const solved = await solveChallenge(src);
  const ms = Date.now() - t0;
  console.log('SHIM SOLVED in ' + ms + 'ms:');
  console.log(JSON.stringify(solved, null, 2));
  if (!solved || solved.__error) { console.log('SHIM FAILED'); process.exit(1); }
  const proof = buildProof(solved);
  console.log('PROOF b64 (' + proof.length + ' chars): ' + proof.slice(0, 80) + '...');
  fs.writeFileSync('proof-shim.txt', proof);
  const gtFile = process.argv[4];
  if (gtFile) {
    const gt = JSON.parse(fs.readFileSync(gtFile, 'utf8'));
    const same = JSON.stringify(solved.client_hashes) === JSON.stringify(gt.client_hashes)
      && JSON.stringify(solved.server_hashes) === JSON.stringify(gt.server_hashes)
      && JSON.stringify(solved.meta) === JSON.stringify(gt.meta);
    console.log('MATCHES JSDOM GROUND TRUTH: ' + same);
    if (!same) {
      console.log('  shim client_hashes: ' + JSON.stringify(solved.client_hashes));
      console.log('  jsdom client_hashes: ' + JSON.stringify(gt.client_hashes));
    }
  }
})();

module.exports = { makeRealm, solveChallenge, buildProof, Element, HTMLElement, HTMLDivElement };
