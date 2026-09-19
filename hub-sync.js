/* ══════════════════════════════════════════════════════════════════
   daily-hub 数据层  ·  hub-sync.js  ·  v2026-09-19-2
   ══════════════════════════════════════════════════════════════════
   【他要解决的问题】原话（2026-09-19）：
     「改了新链接以后我之前比如说记账之类的都没有了 …
      我昨天记过一次账单 今天早上就没了 早上再记一次 下午换链接又没了
      解决这个问题 我不想换链接」

   【根因两条】
     ① **链接会变** —— WorkBuddy 沙箱随换号被回收 → appId 不能复用 → 只能换域名；
     ② **数据存 localStorage** —— localStorage 按 **域名(origin)** 隔离，
        换域名 = 新 origin = 读不到旧数据（看着像"凭空没了"）。

   【解法（两条都对症）】
     ① 页面托管到 **GitHub Pages**：`https://xiaohuya6.github.io/daily-hub/`
        —— 域名跟他的 GitHub 账号走，**跟 WorkBuddy 换号完全无关**，永久不变；
     ② 数据以 **localStorage 为主存储** —— origin 现在永久固定，
        所以**再也不会因为换链接而丢**；同时云端留一份**加密备份**（`data.enc.json`，同源）。

   【为什么数据要同源、要加密（踩过的坑，别再改回去）】
     · 本机 hosts 被 **Steam++** 改过：`api.github.com` / `raw.githubusercontent.com`
       被指到 `127.0.0.1` → **浏览器跨域 fetch GitHub API 必挂**（实测同源 OK200、跨域 TIMEOUT）；
       但 `xiaohuya6.github.io` 是**子域**，不受 `127.0.0.1 github.io` 影响 → 同源可用。
     · 所以数据文件必须放在**同源**（同一个 Pages 站下）；
       同源 = 公开仓库 → **隐私内容（给爸消息/任务/记账）必须 AES-GCM 加密**。

   【算法】与 tools/hub_crypto.js（node 侧）严格一致：
     口令 --PBKDF2-SHA256(100000, salt='daily-hub-v1')--> 32B key
     明文 --AES-256-GCM(iv 12B)--> base64(ct||tag)
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var SALT = 'daily-hub-v1', ITER = 100000;
  var ENC_URL = 'data.enc.json';          // 同源（本目录下）
  var LSK = {
    notes: 'v2-notes', spend: 'v2-spend', dotasks: 'v2-dotasks',
    routines: 'v2-routines', content: 'v2-content'
  };
  var KEYS = ['notes', 'spend', 'dotasks', 'routines'];
  var DIRTY_KEY = 'hub-pending-backup';   // 本地有改动、还没进云端备份

  /* ── 角标（自己建，不依赖页面 DOM）────────────────────────────── */
  var badge = null;
  function setBadge(text, color) {
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'hubsync-badge';
      badge.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:9999;' +
        'font-size:11px;line-height:1.4;padding:3px 8px;border-radius:10px;' +
        'font-family:system-ui,-apple-system,"PingFang SC",sans-serif;' +
        'background:#fff;color:#666;border:1px solid #e5e5e5;opacity:.85;' +
        'pointer-events:none;user-select:none';
      document.body.appendChild(badge);
    }
    badge.textContent = text;
    badge.style.color = color || '#666';
    badge.style.borderColor = color || '#e5e5e5';
  }

  /* ── crypto：PBKDF2 + AES-GCM（与 node 侧 hub_crypto.js 一致）── */
  function b64ToBytes(b64) {
    var bin = atob(String(b64 || '').replace(/\s/g, ''));
    var a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }
  function concat(a, b) {
    var o = new Uint8Array(a.length + b.length);
    o.set(a, 0); o.set(b, a.length);
    return o;
  }
  function deriveKey(pass) {
    var enc = new TextEncoder();
    return crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey'])
      .then(function (base) {
        return crypto.subtle.deriveKey(
          { name: 'PBKDF2', salt: enc.encode(SALT), iterations: ITER, hash: 'SHA-256' },
          base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      });
  }
  function decryptBlob(key, obj) {
    var all = b64ToBytes(obj.ct);
    var ct = all.slice(0, all.length - 16), tag = all.slice(all.length - 16);
    return crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(obj.iv), tagLength: 128 }, key, concat(ct, tag)
    ).then(function (buf) { return JSON.parse(new TextDecoder().decode(buf)); });
  }

  /* ── localStorage 读写 ────────────────────────────────────────── */
  function readTable(k) {
    try { var v = JSON.parse(localStorage.getItem(LSK[k]) || '[]'); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  function writeTable(k, arr) {
    try { localStorage.setItem(LSK[k], JSON.stringify(arr)); } catch (e) {}
  }
  function localSnapshot() {
    var o = { schema: 1, updated: new Date().toISOString(), source: 'daily-hub' };
    for (var i = 0; i < KEYS.length; i++) o[KEYS[i]] = readTable(KEYS[i]);
    try { o.content = JSON.parse(localStorage.getItem(LSK.content) || 'null'); } catch (e) { o.content = null; }
    return o;
  }
  /* 云端 → 本地：**只补本地没有的**（本地才是他的最新记录，绝不用旧的覆盖新的） */
  function mergeInto(cloud) {
    if (!cloud) return 0;
    var added = 0;
    for (var i = 0; i < KEYS.length; i++) {
      var k = KEYS[i];
      if (!Array.isArray(cloud[k]) || !cloud[k].length) continue;
      var mine = readTable(k), seen = {};
      for (var j = 0; j < mine.length; j++) {
        var r = mine[j]; seen[(r && r.id) || ((r && r.day) + '|' + (r && r.kind) + '|' + (r && r.body))] = 1;
      }
      for (var m = 0; m < cloud[k].length; m++) {
        var row = cloud[k][m];
        if (!row) continue;
        var key = row.id || (row.day + '|' + row.kind + '|' + row.body);
        if (seen[key]) continue;
        seen[key] = 1; mine.push(row); added++;
      }
      if (added) writeTable(k, mine);
    }
    /* 内容（今日任务 / 给爸消息 / 例行）：云端有就用云端（内容以云为权威） */
    if (cloud.content) {
      try { localStorage.setItem(LSK.content, JSON.stringify(cloud.content)); } catch (e) {}
      if (window.__HUB_APPLY_CONTENT) { try { window.__HUB_APPLY_CONTENT(cloud.content); } catch (e) {} }
    }
    return added;
  }

  /* ── 入口：口令 → 解密云备份 → 合并 ─────────────────────────── */
  function unlock(pass) {
    if (!(window.crypto && crypto.subtle)) {
      setBadge('☁ 本机数据只在本机（浏览器不支持加密）', '#c0392b');
      if (window.__HUB_RENDER) { try { window.__HUB_RENDER(); } catch (e) {} }
      return Promise.resolve(false);
    }
    setBadge('☁ 读取云端备份…', '#888');
    return deriveKey(pass).then(function (key) {
      return fetch(ENC_URL + '?v=' + Date.now(), { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (blob) { return decryptBlob(key, blob); })
        .then(function (cloud) {
          var added = mergeInto(cloud);
          setBadge(added ? '☁ 云端补回 ' + added + ' 条' : '☁ 已同步（云端备份在位）', '#2e7d32');
          if (window.__HUB_RENDER) { try { window.__HUB_RENDER(); } catch (e) {} }
          return true;
        });
    }).catch(function (e) {
      var m = String((e && e.message) || e);
      setBadge(m === 'TOKEN_BAD' || /operation|decrypt|DataError/i.test(m)
        ? '☁ 口令对不上云端备份（本机数据照常用）'
        : '☁ 云端备份暂时读不到（本机数据照常用）', '#c0392b');
      if (window.__HUB_RENDER) { try { window.__HUB_RENDER(); } catch (e2) {} }
      return false;
    });
  }

  /* ── 本地写之后：只标记「待备份」，不发网络请求 ─────────────── */
  function touch() {
    try { localStorage.setItem(DIRTY_KEY, String(Date.now())); } catch (e) {}
    setBadge('☁ 已存本机（待同步云端）', '#f39c12');
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { timer = null; quiet(); }, 2500);
  }
  var timer = null;
  function quiet() {
    var d = 0;
    try { d = Number(localStorage.getItem(DIRTY_KEY) || 0); } catch (e) {}
    if (d) setBadge('☁ 已存本机（待同步云端）', '#f39c12');
    else setBadge('☁ 已同步', '#2e7d32');
  }

  /* ── 导出：给「手动/自动备份到云端」用 ─────────────────────── */
  function exportLocal() {
    var blob = new Blob([JSON.stringify(localSnapshot(), null, 1)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'daily-hub-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }
  /* 备份完成后由我（WorkBuddy）在浏览器里调用，清掉「待备份」标记 */
  function markBackedUp() {
    try { localStorage.removeItem(DIRTY_KEY); } catch (e) {}
    setBadge('☁ 已同步（云端备份在位）', '#2e7d32');
  }

  window.HUBSYNC = {
    unlock: unlock,
    touch: touch,
    exportLocal: exportLocal,
    markBackedUp: markBackedUp,
    snapshot: localSnapshot,
    isDirty: function () { try { return !!localStorage.getItem(DIRTY_KEY); } catch (e) { return false; } },
    /* 读任意**同源加密文件** —— 给 job.html 等新页面复用同一套 PBKDF2+AES-GCM，
       不用各写一份（写两份 = 以后改算法会漏改一处）。 */
    readEncrypted: function (url, pass) {
      return deriveKey(pass).then(function (key) {
        return fetch(url + '?v=' + Date.now(), { cache: 'no-store' })
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
          })
          .then(function (blob) { return decryptBlob(key, blob); });
      });
    },
    version: '2026-09-19-3'
  };

  /* 页面加载先按本地渲染（不等网络），保证任何情况下都是「打开就有数据」 */
  window.addEventListener('DOMContentLoaded', function () {
    if (window.__HUB_RENDER) { try { window.__HUB_RENDER(); } catch (e) {} }
  });
})();
