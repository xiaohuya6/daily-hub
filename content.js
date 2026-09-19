/* ══════════════════════════════════════════════════════════════
   内容空壳 —— 真实内容不在这里
   ══════════════════════════════════════════════════════════════
   为什么：本页托管在 **公开仓库**（GitHub Pages），而「给爸消息 / 今日任务 /
   待办」属于私人内容 → 不能写进前端代码。
   ⇒ 真实内容存在**私有数据仓** data.json 的 `content` 字段，
      页面启动时由 hub-sync.js 拉回来热更新（走 window.__HUB_APPLY_CONTENT）。

   本文件只声明默认值，防止同步层未就绪时页面报错。
   要改文案 → 改知识库里的 tools/hub_publish.py content（或直接改私有仓 data.json）。
   ══════════════════════════════════════════════════════════════ */
window.CONTENT = window.CONTENT || {
  version: '',
  snapshotTasks: [],
  dad: { morning: '', evening: '' },
  routines: [],
  backlogSeeds: []
};
