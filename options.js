const DEFAULTS = self.XRC_DEFAULTS;
const $ = (id) => document.getElementById(id);
const msg = (t) => ($('msg').textContent = t);

function load() {
  chrome.storage.local.get({ ...DEFAULTS, replied: {}, daily: { date: '', count: 0 } }, (s) => {
    for (const k of Object.keys(DEFAULTS)) {
      const el = $(k);
      if (el.type === 'checkbox') el.checked = s[k];
      else el.value = s[k];
    }
    const todayCount = s.daily.date === new Date().toLocaleDateString('sv') ? s.daily.count : 0;
    $('stats').textContent = `今日已回复 ${todayCount} 条 · 共记住 ${Object.keys(s.replied).length} 条已回复的帖子`;
  });
}

async function save() {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    const el = $(k);
    if (el.type === 'checkbox') out[k] = el.checked;
    else if (el.type === 'number') {
      const n = Number(el.value);
      const min = Number(el.min);
      const max = Number(el.max);
      out[k] = Number.isFinite(n) && el.value !== '' ? Math.min(max, Math.max(min, n)) : DEFAULTS[k];
      el.value = out[k];
    } else out[k] = el.value.trim();
  }
  if (out.batchMax < out.batchMin) out.batchMax = $('batchMax').value = out.batchMin;
  if (!out.persona) out.persona = $('persona').value = DEFAULTS.persona;
  await chrome.storage.local.set(out);
}

$('save').onclick = async () => {
  await save();
  msg('已保存 ✓');
};

$('test').onclick = async () => {
  await save();
  msg('测试中…');
  chrome.runtime.sendMessage({ type: 'test' }, (res) =>
    msg(res?.ok ? `连接成功：${res.text}` : `失败：${res?.error || chrome.runtime.lastError?.message}`)
  );
};

$('clearReplied').onclick = async () => {
  if (!confirm('清空后，之前回复过的帖子可能会再次生成草稿。确定吗？')) return;
  await chrome.storage.local.set({ replied: {} });
  load();
  msg('已清空');
};

const KIND_LABEL = { retry: '临时', fatal: '这条发不了', ratelimit: 'X 限频', limit: '需要处理' };

function renderErrLog() {
  chrome.storage.local.get({ errLog: [] }, ({ errLog }) => {
    const box = $('errLog');
    box.replaceChildren();
    if (!errLog.length) {
      const empty = document.createElement('div');
      empty.className = 'err-empty';
      empty.textContent = '暂无错误';
      box.appendChild(empty);
      return;
    }
    for (const e of errLog) {
      const item = document.createElement('div');
      item.className = 'err';
      const head = document.createElement('div');
      head.className = 'err-head';
      const time = document.createElement('span');
      time.textContent = new Date(e.at).toLocaleString();
      const kind = document.createElement('span');
      kind.className = 'err-kind';
      kind.textContent = KIND_LABEL[e.kind] || e.kind || '未知';
      const link = document.createElement('a');
      link.href = `https://x.com/i/status/${e.id}`;
      link.target = '_blank';
      link.textContent = '原帖';
      head.append(time, kind, link);
      const m = document.createElement('div');
      m.className = 'err-msg';
      m.textContent = e.error;
      item.append(head, m);
      if (e.snippet) {
        const s = document.createElement('div');
        s.className = 'err-snip';
        s.textContent = `页面内容：${e.snippet}`;
        item.appendChild(s);
      }
      box.appendChild(item);
    }
  });
}

$('clearErr').onclick = async () => {
  await chrome.storage.local.set({ errLog: [] });
  renderErrLog();
};
chrome.storage.onChanged.addListener((changes) => {
  if (changes.errLog) renderErrLog();
});
renderErrLog();

// 改完任何一项都自动保存，不用记得点「保存」
document.querySelectorAll('input, select, textarea').forEach((el) =>
  el.addEventListener('change', async () => {
    await save();
    msg('已自动保存 ✓');
  })
);

load();
