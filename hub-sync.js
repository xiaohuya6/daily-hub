/* ══════════════════════════════════════════════════════════════════
   daily-hub 云端同步层  ·  hub-sync.js  ·  2026-09-19
   ══════════════════════════════════════════════════════════════════
   【为什么有这一层】他 2026-09-19 原话：
     「改了新链接以后我之前比如说记账之类的都没有了 …
      我昨天记过一次账单 今天早上就没了 早上再记一次 下午换链接又没了
      解决这个问题 我不想换链接」
   根因两条：
     ① 页面链接会变 —— WorkBuddy 沙箱随「换号」被回收 → appId 不能复用 → 只能换域名；
     ② 数据存 localStorage —— 而 localStorage 按 **域名** 隔离，
        换域名 = 新 origin = 读不到旧数据（看着像"没了"）。
   解法：数据搬到 **GitHub 私有仓库**（跟 WorkBuddy 账号、跟链接都无关），
        页面托管到 **GitHub Pages**（链接永久不变）。

   【工作方式】
     · 读：GET /repos/xiaohuya6/daily-hub-data/contents/data.json
     · 写：PUT 同路径（带 sha；409 冲突 → 重新拉取合并 → 重试）
     · 本地 localStorage 仍作缓存（离线可用）；云端是**真源**
     · token 来源：URL hash `#t=xxx` 一次性配对（存进 localStorage 后清掉 hash）
                  或 localStorage['hub-gh-token']
   【不做什么】不碰页面结构、不碰文案、不碰渲染 —— 只做「存取 + 状态角标」。
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var OWNER = 'xiaohuya6';
  var REPO = 'daily-hub-data';
  var FILE = 'data.json';
  var API = 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/contents/' + FILE;
  var TK = 'hub-gh-token';          // token 在 localStorage 的键
  var LSK = {                        // 本地缓存键（与页面原有 v2- 前缀一致）
    notes: 'v2-notes', spend: 'v2-spend', dotasks: 'v2-dotasks', routines: 'v2-routines',
    content: 'v2-content'
  };
  var KEYS = ['notes', 'spend', 'dotasks', 'routines'];

  var sha = null;        // 云端文件当前 sha（PUT 需要）
  var dirty = false;     // 本地有未推送改动
  var timer = null;      // push 防抖
  var busy = false;      // 防止并发
  var lastErr = '';

  /* ── token ───────────────────────────────────────────────────── */
  function readToken() {
    var m = (location.hash || '').match(/[#&]t=([^&]+)/);
    if (m) {
      try { localStorage.setItem(TK, decodeURIComponent(m[1])); } catch (e) {}
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    }
    return localStorage.getItem(TK) || '';
  }
  var TOKEN = readToken();

  /* ── base64 ↔ utf8 ───────────────────────────────────────────── */
  function b64enc(str) {
    var bytes = new TextEncoder().encode(str), bin = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  }
  function b64dec(b64) {
    var bin = atob((b64 || '').replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /* ── 状态角标（自己创建，不依赖页面已有 DOM）─────────────────── */
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

  /* ── 读本地四张表 → 组装 data.json 对象 ─────────────────────── */
  function snapshot() {
    var out = { schema: 1, updated: new Date().toISOString(), source: 'daily-hub' };
    for (var i = 0; i < KEYS.length; i++) {
      var k = KEYS[i], v = [];
      try { v = JSON.parse(localStorage.getItem(LSK[k]) || '[]'); } catch (e) { v = []; }
      out[k] = Array.isArray(v) ? v : [];
    }
    /* content（今日任务/给爸消息/例行）由云端持有 —— 本地只是缓存，必须原样带回去，
       否则一次 push 就把它抹掉了。本地没有就退回 window.CONTENT。 */
    try {
      var c = localStorage.getItem(LSK.content);
      out.content = c ? JSON.parse(c) : (window.CONTENT || null);
    } catch (e) { out.content = window.CONTENT || null; }
    return out;
  }

  /* ── 把云端对象写进本地四张表 ─────────────────────────────── */
  function apply(obj) {
    for (var i = 0; i < KEYS.length; i++) {
      var k = KEYS[i];
      if (!obj || !Array.isArray(obj[k])) continue;
      try { localStorage.setItem(LSK[k], JSON.stringify(obj[k])); } catch (e) {}
    }
    /* 内容（今日任务 / 给爸消息 / 例行 / 待办预设）也从云端来 ——
       因为页面托管在公开仓库，含隐私的文案不能写在前端代码里。 */
    if (obj && obj.content) {
      try { localStorage.setItem(LSK.content, JSON.stringify(obj.content)); } catch (e) {}
      if (window.__HUB_APPLY_CONTENT) {
        try { window.__HUB_APPLY_CONTENT(obj.content); } catch (e) {}
      }
    }
  }

  /* ── 合并：按 id 并集（云端为准，本地独有的补上）───────────── */
  function merge(cloud, local) {
    var out = { schema: 1, updated: new Date().toISOString(), source: 'daily-hub' };
    /* content 只认云端（那是权威内容，本地不产生 content 改动） */
    if (cloud && cloud.content) out.content = cloud.content;
    else if (local && local.content) out.content = local.content;
    for (var i = 0; i < KEYS.length; i++) {
      var k = KEYS[i];
      var c = (cloud && Array.isArray(cloud[k])) ? cloud[k] : [];
      var l = (local && Array.isArray(local[k])) ? local[k] : [];
      var seen = {}, merged = [];
      var all = c.concat(l);
      for (var j = 0; j < all.length; j++) {
        var row = all[j];
        if (!row) continue;
        var id = row.id || (row.day + '|' + row.kind + '|' + row.body);
        if (seen[id]) continue;
        seen[id] = 1; merged.push(row);
      }
      out[k] = merged;
    }
    return out;
  }

  /* ── 网络 ───────────────────────────────────────────────────── */
  function headers() {
    return {
      'Authorization': 'token ' + TOKEN,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };
  }
  function getCloud() {
    return fetch(API + '?t=' + Date.now(), { headers: headers(), cache: 'no-store' })
      .then(function (r) {
        if (r.status === 404) return { obj: null, sha: null };
        if (r.status === 401 || r.status === 403) throw new Error('TOKEN_BAD');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json().then(function (d) {
          return { obj: JSON.parse(b64dec(d.content)), sha: d.sha };
        });
      });
  }
  function putCloud(obj, useSha, msg) {
    var body = { message: msg || 'update from daily-hub', content: b64enc(JSON.stringify(obj, null, 1)) };
    if (useSha) body.sha = useSha;
    return fetch(API, { method: 'PUT', headers: headers(), body: JSON.stringify(body) })
      .then(function (r) {
        if (r.status === 409 || r.status === 422) throw new Error('CONFLICT');
        if (r.status === 401 || r.status === 403) throw new Error('TOKEN_BAD');
        if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 120)); });
        return r.json();
      });
  }

  /* ── pull：云端 → 本地（本地有未推送改动时先推再拉）────────── */
  function pull(force) {
    if (!TOKEN) { setBadge('☁ 未配对（数据只在本机）', '#c0392b'); return Promise.resolve(false); }
    if (busy) return Promise.resolve(false);
    if (dirty && !force) return push();
    busy = true;
    setBadge('☁ 同步中…', '#888');
    return getCloud().then(function (res) {
      sha = res.sha;
      if (!res.obj) { dirty = true; busy = false; return push(); }
      apply(res.obj);
      dirty = false; busy = false;
      setBadge('☁ 已同步 ' + new Date().toTimeString().slice(0, 5), '#2e7d32');
      if (window.__HUB_RENDER) { try { window.__HUB_RENDER(); } catch (e) {} }
      return true;
    }).catch(function (e) {
      busy = false;
      lastErr = String(e && e.message || e);
      setBadge(lastErr === 'TOKEN_BAD' ? '☁ 配对已失效（要重新配对）' : '☁ 同步失败（数据已存本机）', '#c0392b');
      return false;
    });
  }

  /* ── push：本地 → 云端（带重试；冲突则合并）────────────────── */
  function push() {
    if (!TOKEN) { setBadge('☁ 未配对（数据只在本机）', '#c0392b'); return Promise.resolve(false); }
    if (busy) { dirty = true; return Promise.resolve(false); }
    busy = true;
    setBadge('☁ 上传中…', '#888');
    var mine = snapshot();
    return putCloud(mine, sha, 'update from daily-hub')
      .then(function (d) {
        sha = d.content.sha;
        dirty = false; busy = false;
        setBadge('☁ 已同步 ' + new Date().toTimeString().slice(0, 5), '#2e7d32');
        return true;
      })
      .catch(function (e) {
        var msg = String(e && e.message || e);
        if (msg === 'CONFLICT') {   // 云端被别人改过 → 拉下来合并再推一次
          busy = false;
          return getCloud().then(function (res) {
            sha = res.sha;
            var merged = merge(res.obj, mine);
            apply(merged);
            return putCloud(merged, sha, 'merge from daily-hub').then(function (d2) {
              sha = d2.content.sha; dirty = false;
              setBadge('☁ 已合并同步', '#2e7d32');
              if (window.__HUB_RENDER) { try { window.__HUB_RENDER(); } catch (e2) {} }
              return true;
            });
          }).catch(function (e2) {
            busy = false; dirty = true;
            setBadge('☁ 同步失败（数据已存本机）', '#c0392b');
            return false;
          });
        }
        busy = false; dirty = true;
        setBadge(msg === 'TOKEN_BAD' ? '☁ 配对已失效（要重新配对）' : '☁ 同步失败（数据已存本机）', '#c0392b');
        return false;
      });
  }

  /* ── 对外接口 ───────────────────────────────────────────────── */
  window.HUBSYNC = {
    /* 任何本地写操作后调用：标记脏 + 防抖 1.2s 上传 */
    touch: function () {
      dirty = true;
      setBadge('☁ 待上传…', '#f39c12');
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { timer = null; push(); }, 1200);
    },
    /* 进主界面时调用：先拉云端，再渲染 */
    boot: function () {
      if (!TOKEN) { setBadge('☁ 未配对（数据只在本机）', '#c0392b');
        if (window.__HUB_RENDER) { try { window.__HUB_RENDER(); } catch (e) {} }
        return Promise.resolve(false); }
      setBadge('☁ 连接中…', '#888');
      return pull(true).then(function (r) {
        /* pull 成功时内部已重画；失败/无数据时这里兜底重画，保证页面不空 */
        if (!r && window.__HUB_RENDER) { try { window.__HUB_RENDER(); } catch (e) {} }
        return r;
      });
    },
    pull: pull,
    push: push,
    hasToken: function () { return !!TOKEN; },
    /* 供页面做「配对」用：传入 token 后立即拉取 */
    setToken: function (t) {
      TOKEN = String(t || '').trim();
      try { localStorage.setItem(TK, TOKEN); } catch (e) {}
      return pull(true);
    },
    /* 断网/离线时兜底：把本地快照导出成文件（他手动保存也行） */
    exportLocal: function () {
      var blob = new Blob([JSON.stringify(snapshot(), null, 1)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'daily-hub-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
    }
  };

  /* 回到前台 / 每 60s 轻量拉一次（单人使用，冲突概率极低） */
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && TOKEN && !dirty) pull(false);
  });
  setInterval(function () { if (TOKEN && !dirty && !busy) pull(false); }, 60000);
})();
