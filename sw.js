/* 今日工作台 · 离线壳（2026-11-22）
   为什么要有：他要「手机 App」，不是「打开浏览器等网页」——
   装到桌面后断网也得能开、能看今天的任务和账，否则跟网页没区别。
   口径：壳（页面/脚本/图标）缓存优先；云端数据 data.enc.json 网络优先（拿不到就用上次那份）。 */
var CACHE = 'hub-app-20261123-12';   /* 🔴 改 app.html/content.js 必须同时升这里，否则他手机吃的还是旧缓存 */
var SHELL = [
  './',
  './app.html',
  './content.js',
  './assets/hero.jpg',
  './assets/avatar-her.png',
  './hub-sync.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(SHELL.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (ks) {
      return Promise.all(ks.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  /* 云端加密数据：先网络（要最新），失败退回缓存 */
  if (/data\.enc\.json$/.test(url.pathname)) {
    e.respondWith(
      fetch(req).then(function (r) {
        var copy = r.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return r;
      }).catch(function () { return caches.match(req); })
    );
    return;
  }

  /* 壳：缓存优先，顺手更新 */
  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) {
        fetch(req).then(function (r) {
          if (r && r.ok) caches.open(CACHE).then(function (c) { c.put(req, r.clone()); });
        }).catch(function () {});
        return hit;
      }
      return fetch(req).then(function (r) {
        if (r && r.ok && r.type === 'basic') {
          var copy = r.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return r;
      }).catch(function () { return caches.match('./app.html'); });
    })
  );
});
