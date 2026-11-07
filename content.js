// 内容脚本：单条 AI 回复按钮 + 自动浏览 / 批量草稿面板
(() => {
  if (window.__xrcLoaded) return; // 防止重复注入
  window.__xrcLoaded = true;

  // X 改版时只需要改这里
  const SEL = {
    tweet: 'article[data-testid="tweet"]',
    text: '[data-testid="tweetText"]',
    user: '[data-testid="User-Name"]',
    timeLink: 'a[href*="/status/"] time',
    quote: 'div[role="link"]',
    actionBar: '[role="group"]',
    replyBtn: '[data-testid="reply"]',
    dialog: '[role="dialog"]',
    editor: '[data-testid="tweetTextarea_0"]',
    likeBtn: '[data-testid="like"]', // 未点赞时的爱心（已点赞是 data-testid="unlike"）
    unlikeBtn: '[data-testid="unlike"]',
    sendBtn: '[data-testid="tweetButton"]', // 弹窗里的发送按钮
    inlineSendBtn: '[data-testid="tweetButtonInline"]', // 原帖页面下方回复框的按钮
    photo: '[data-testid="tweetPhoto"] img',
    video: '[data-testid="videoPlayer"], [data-testid="videoComponent"]',
    card: '[data-testid="card.wrapper"]',
    profileLink: '[data-testid="AppTabBar_Profile_Link"]',
  };

  let settings = { ...self.XRC_DEFAULTS };
  let replied = {}; // tweetId -> 时间戳
  let daily = { date: '', count: 0 };
  let panelReady = false; // 回复页（/intent/）不创建面板
  let browsing = false;
  let sending = false;
  let stopBatch = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const today = () => new Date().toLocaleDateString('sv');
  const clip = (s, n) => {
    const a = Array.from(s || '');
    return a.length > n ? a.slice(0, n).join('') + '…' : a.join('');
  };
  const charLen = (s) => Array.from(s || '').length;
  const MAX_RETRIES = 3; // 单条草稿临时失败最多重试几次
  const MAX_CONSECUTIVE_FAILS = 5; // 连续失败这么多条就暂停整个队列
  const RATE_LIMIT_PAUSE = 10 * 60 * 1000; // X 限频时队列暂停多久
  const todayCount = () => (daily.date === today() ? daily.count : 0);

  async function waitFor(selector, timeout = 5000, root = document) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = root.querySelector(selector);
      if (el) return el;
      await sleep(100);
    }
    return null;
  }

  function toast(msg, ms = 3500) {
    const t = document.createElement('div');
    t.className = 'xrc-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  // ---------- 与后台通信（处理扩展重载后的失效） ----------
  let dead = false;
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };
  function handleDead() {
    if (dead) return;
    dead = true;
    stopBatch = true;
    if (panelReady) stopBrowsing();
    toast('扩展已更新或重新加载，请刷新页面后再用', 8000);
  }
  function send(msg) {
    return new Promise((resolve, reject) => {
      if (!alive()) {
        handleDead();
        return reject(new Error('扩展已失效，请刷新页面'));
      }
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          const err = chrome.runtime.lastError;
          if (err) {
            if (/context invalidated/i.test(err.message)) handleDead();
            return reject(new Error(err.message));
          }
          if (res?.ok) return resolve(res);
          const e = new Error(res?.error || '请求失败');
          e.kind = res?.kind; // 发送失败的类型，见 runIntentPage
          reject(e);
        });
      } catch (e) {
        handleDead();
        reject(e);
      }
    });
  }
  const generate = (tweet) => send({ type: 'generate', tweet }).then((r) => r.text);

  function markReplied(id) {
    if (!id) return;
    if (!replied[id]) {
      replied[id] = Date.now(); // 先本地更新，后台负责持久化
      daily = daily.date === today() ? { date: daily.date, count: daily.count + 1 } : { date: today(), count: 1 };
    }
    send({ type: 'markReplied', id }).catch(() => {});
    if (!panelReady) return;
    refreshButtons();
    updateStatus();
  }

  // ---------- 插入文字到 X 的 Draft.js 编辑器 ----------
  async function insertText(box, text) {
    box.focus();
    await sleep(50);
    // 用 execCommand 会被浏览器和 Draft.js 各插一次，所以模拟粘贴
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(150);
    if (!box.innerText.trim()) document.execCommand('insertText', false, text);
  }

  // ---------- 回复后自动点赞 ----------
  // 失败不影响回复结果；已经赞过的不会再点（再点会变成取消点赞）
  async function likeAfterReply(id) {
    const { autoLike = self.XRC_DEFAULTS.autoLike } = await chrome.storage.local.get('autoLike').catch(() => ({}));
    if (!autoLike || !id) return false;
    await sleep(800 + Math.random() * 1200); // 别跟回复同一瞬间
    const article = findArticleById(id);
    if (!article || article.querySelector(SEL.unlikeBtn)) return false;
    const btn = article.querySelector(SEL.likeBtn);
    if (!btn) return false;
    btn.click();
    for (let i = 0; i < 10; i++) {
      await sleep(300);
      if (article.querySelector(SEL.unlikeBtn)) return true;
    }
    return false;
  }

  // 你手动点「回复」时记下这条帖子
  let pending = null; // { id, scope }
  const pendingValid = () => pending && pending.scope.isConnected;
  document.addEventListener(
    'click',
    (e) => {
      const b = e.target.closest?.(SEL.sendBtn);
      if (b && pendingValid() && b.getAttribute('aria-disabled') !== 'true') {
        markReplied(pending.id);
        likeAfterReply(pending.id);
        pending = null;
      }
    },
    true
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && pendingValid() && e.target.closest?.(SEL.editor)) {
        markReplied(pending.id);
        likeAfterReply(pending.id);
        pending = null;
      }
    },
    true
  );

  // ---------- 发送窗口：打开原帖页面，用页面下方的回复框回复 ----------
  // 以前用 /intent/post?in_reply_to=… 发送，但 X 有时会忽略回复对象，把回复发成独立的新帖子。
  // 原帖页面下方的回复框一定是回复这条帖子，而且发之前可以核对原帖 ID。
  let jobStarted = false;
  if (new URLSearchParams(location.search).has('xrc_job')) {
    runReplyJob();
    return;
  }
  // 手动打开的回复页：等你自己点发送
  if (location.pathname.startsWith('/intent/')) {
    const replyTo = new URLSearchParams(location.search).get('in_reply_to');
    if (replyTo) pending = { id: replyTo, scope: document.body };
    return;
  }

  // 失败类型：retry 临时问题可重试 / fatal 这条发不了 / ratelimit X 限频，整个队列暂停一会 / limit 需要你处理，队列停止
  async function runReplyJob(job = null) {
    if (jobStarted) return;
    jobStarted = true;
    if (!job) {
      try {
        job = (await send({ type: 'job' })).job;
      } catch {}
    }
    if (!job) return;
    const snippet = () => clip((document.body?.innerText || '').replace(/\s+/g, ' ').trim(), 300);
    const done = (r) => send({ type: 'jobDone', ...r }).catch(() => {});
    const fail = (error, kind = 'retry') => done({ ok: false, error, kind, snippet: snippet() });
    const failWithHint = (prefix, fallbackKind = 'retry') => {
      const h = pageHint();
      return fail(`${prefix}（${h.label}）`, h.label === '原因不明' ? fallbackKind : h.kind);
    };

    // 你在主窗口里操作时，主窗口会盖住发送窗口；被完全盖住的窗口浏览器不渲染
    const waitVisible = async (ms) => {
      const t = Date.now();
      while (document.hidden && Date.now() - t < ms) await sleep(500);
      return !document.hidden;
    };
    if (!(await waitVisible(15000))) return fail('发送窗口被其他窗口挡住了');

    // 核对：页面上要有这条原帖
    let targetId = job.id;
    const focal = await waitFor(`${SEL.tweet} a[href*="/status/${targetId}"]`, 20000);
    if (!focal) return failWithHint('原帖没加载出来');

    // 作者编辑过帖子：旧版本下面没有回复框，跳到「查看最新帖子」再回复
    let box = await waitFor(SEL.editor, 3000);
    if (!box) {
      const latest = [...document.querySelectorAll('a[href*="/status/"]')].find((a) =>
        /查看最新|最新帖子|最新版本|latest post|latest version|view the latest/i.test(a.innerText)
      );
      const newId = latest?.href.match(/status\/(\d+)/)?.[1];
      if (newId && newId !== targetId) {
        latest.click();
        targetId = newId;
        if (!(await waitFor(`${SEL.tweet} a[href*="/status/${targetId}"]`, 15000))) {
          return failWithHint('帖子有新版本，但新版本没加载出来');
        }
      }
      // 原帖下方的回复框（作者限制回复时不会出现）
      box = await waitFor(SEL.editor, 8000);
    }
    if (!box || !document.querySelector(SEL.inlineSendBtn)) return failWithHint('原帖下方没有回复框', 'fatal');
    box.click();
    await sleep(300);
    await insertText(box, job.text);

    const enabledBtn = () => {
      const b = document.querySelector(SEL.inlineSendBtn);
      return b && b.getAttribute('aria-disabled') !== 'true' ? b : null;
    };
    const waitEnabled = async (ms) => {
      const t = Date.now();
      while (Date.now() - t < ms) {
        const b = enabledBtn();
        if (b) return b;
        await sleep(300);
      }
      return null;
    };

    let btn = await waitEnabled(5000);
    if (!btn) {
      // 编辑器没认到输入 → 清空重新粘贴一次
      box.focus();
      document.execCommand('selectAll', false);
      document.execCommand('delete', false);
      await sleep(200);
      await insertText(box, job.text);
      btn = await waitEnabled(5000);
    }
    if (!btn && document.hidden) return fail('发送窗口被其他窗口挡住了');
    if (!btn) return failWithHint('回复按钮是灰色的');
    // 发之前确认框里就是这条草稿，避免重复粘贴之类的问题
    const typed = box.innerText.replace(/\s+/g, '');
    if (typed !== job.text.replace(/\s+/g, '')) return fail(`回复框里的内容不对（${clip(box.innerText.trim(), 40)}），已取消`);

    // 回复的是新版本时，把新 ID 也记为已回复
    // 发送窗口在 done 之后会被清空，所以先点赞再报告结果
    const success = async (extra = {}) => {
      const liked = await likeAfterReply(targetId).catch(() => false);
      return done({ ok: true, newId: targetId !== job.id ? targetId : undefined, liked, ...extra });
    };
    await send({ type: 'jobClicked' }).catch(() => {});
    btn.click();
    const t1 = Date.now();
    while (Date.now() - t1 < 12000) {
      await sleep(300);
      // X 的提示条既可能是「已发送」，也可能是报错
      const toastText = document.querySelector('[data-testid="toast"]')?.innerText?.trim() || '';
      if (toastText) {
        if (/sent|已发送|发送成功|已發送/i.test(toastText)) return success();
        return fail(`X 提示：${clip(toastText, 80)}`, classify(toastText).kind);
      }
      // 发送成功后回复框会被清空
      const ed = document.querySelector(SEL.editor);
      if (!ed || !ed.innerText.trim()) return success();
    }
    success({ uncertain: true });
  }

  // 根据 X 页面上的文字判断失败原因和类型
  const HINTS = [
    [/already said that|duplicate|重复/i, '内容和之前的回复重复', 'fatal'],
    [/automated|too many|rate limit|try again later|稍后再试|请稍后|操作过于频繁/i, 'X 限制了发送频率', 'ratelimit'],
    [/can.?t reply|cannot reply|limited who can reply|无法回复|不能回复|限制了.{0,6}回复/i, '作者限制了谁可以回复', 'fatal'],
    [/doesn.?t exist|has been deleted|deleted|不存在|已被删除|已删除/i, '原帖已删除', 'fatal'],
    [/daily limit|over the.*limit|每日.{0,4}上限|超出.{0,4}限制/i, '达到 X 的发帖上限', 'limit'],
    [/verify|verification|验证|unlock|locked|锁定/i, 'X 要求验证账号', 'limit'],
    [/log in|sign in|登录/i, '未登录', 'limit'],
    [/something went wrong|出错了|出了点问题/i, 'X 页面出错', 'retry'],
  ];
  function classify(text) {
    for (const [re, label, kind] of HINTS) if (re.test(text)) return { label, kind };
    return { label: '原因不明', kind: 'retry' };
  }
  const pageHint = () => classify(document.body?.innerText || '');

  // ---------- 读取设置 ----------
  chrome.storage.local.get({ ...self.XRC_DEFAULTS, replied: {}, daily: { date: '', count: 0 } }, (s) => {
    replied = s.replied;
    daily = s.daily;
    delete s.replied;
    delete s.daily;
    settings = { ...settings, ...s };
    if (!panelReady) return;
    refreshButtons();
    updateStatus();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [k, v] of Object.entries(changes)) {
      if (k === 'replied') replied = v.newValue || {};
      else if (k === 'daily') daily = v.newValue || { date: '', count: 0 };
      else settings[k] = v.newValue;
    }
    if (!panelReady) return;
    // 间隔改了立刻生效（不用等下一条发完）
    if ('batchMin' in changes || 'batchMax' in changes) nextGap = randomGap();
    if ('maxLen' in changes) refreshCounters();
    refreshButtons();
    updateStatus();
  });

  // ---------- 帖子解析（只取必要信息，控制 token） ----------
  function getTweetId(article) {
    return article.querySelector(SEL.timeLink)?.closest('a')?.href.match(/status\/(\d+)/)?.[1] || '';
  }

  function getTweetData(article) {
    const texts = [...article.querySelectorAll(SEL.text)];
    const main = texts.find((t) => !t.closest(SEL.quote));
    const quoteEl = texts.find((t) => t.closest(SEL.quote));
    const handle = (article.querySelector(SEL.user)?.innerText || '').match(/@(\w+)/)?.[1] || '';
    const url = article.querySelector(SEL.timeLink)?.closest('a')?.href || '';
    const photos = [...article.querySelectorAll(SEL.photo)].filter((i) => !i.closest(SEL.quote));
    const alts = photos.map((i) => i.alt).filter((a) => a && !/^(image|图像|图片)$/i.test(a));
    const media = [];
    if (photos.length) media.push(alts.length ? `图片:${clip(alts.join('；'), 120)}` : `${photos.length}张图片`);
    if (article.querySelector(SEL.video)) media.push('视频');
    const card = article.querySelector(SEL.card)?.innerText?.replace(/\s+/g, ' ').trim();
    return {
      id: url.match(/status\/(\d+)/)?.[1] || '',
      url,
      handle,
      text: clip(main?.innerText?.trim(), 400),
      quote: quoteEl ? clip(quoteEl.innerText.trim(), 150) : '',
      media: media.join('，'),
      card: clip(card, 80),
    };
  }

  const isAd = (article) =>
    [...article.querySelectorAll('span')].some((s) => /^(Ad|Promoted|广告|推广)$/.test(s.textContent.trim()));
  const myHandle = () => document.querySelector(SEL.profileLink)?.getAttribute('href')?.slice(1).toLowerCase() || '';

  function findArticleById(id) {
    for (const a of document.querySelectorAll(SEL.tweet)) if (getTweetId(a) === id) return a;
    return null;
  }

  // 在当前页打开回复框并填入（由你手动点「回复」）
  async function fillReply(article, text, id) {
    article.querySelector(SEL.replyBtn)?.click();
    const dialog = await waitFor(SEL.dialog);
    const box = dialog && (await waitFor(SEL.editor, 5000, dialog));
    if (!box) {
      await navigator.clipboard.writeText(text).catch(() => {});
      toast('未找到回复框，草稿已复制到剪贴板');
      return false;
    }
    await insertText(box, text);
    pending = { id, scope: dialog };
    toast('草稿已填入，请检查后手动点击「回复」');
    return true;
  }

  // 原帖不在页面上时：复制草稿，新标签页打开原帖，你在原帖下方粘贴回复
  async function openIntent(id, text) {
    await navigator.clipboard.writeText(text).catch(() => {});
    toast('草稿已复制，正在打开原帖，在下方回复框粘贴后发送', 5000);
    window.open(`https://x.com/i/status/${id}`, '_blank');
  }

  // ---------- 单条：每条帖子上的按钮 ----------
  function setBtnState(article, btn) {
    const done = !!replied[getTweetId(article)];
    btn.textContent = done ? '✓ 已回复' : '✨ AI回复';
    btn.classList.toggle('xrc-done', done);
  }

  function refreshButtons() {
    document.querySelectorAll('.xrc-btn').forEach((b) => {
      const a = b.closest(SEL.tweet);
      if (a && !b.disabled) setBtnState(a, b);
    });
  }

  async function onSingleClick(e, article, btn) {
    e.preventDefault();
    e.stopPropagation();
    const tweet = getTweetData(article);
    if (!tweet.id) return toast('无法识别这条帖子');
    if (!tweet.text && !tweet.quote && !tweet.media) return toast('这条帖子没有可回复的内容');
    if (replied[tweet.id] && !confirm('这条帖子已经回复过，仍要再生成一条吗？')) return;
    btn.disabled = true;
    btn.textContent = '生成中…';
    try {
      await fillReply(article, await generate(tweet), tweet.id);
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
      setBtnState(article, btn);
    }
  }

  function injectButtons() {
    for (const article of document.querySelectorAll(`${SEL.tweet}:not([data-xrc])`)) {
      const groups = article.querySelectorAll(SEL.actionBar);
      const bar = groups[groups.length - 1];
      if (!bar) continue; // 还没渲染完，下次再试
      article.setAttribute('data-xrc', '1');
      const btn = document.createElement('button');
      btn.className = 'xrc-btn';
      btn.addEventListener('click', (e) => onSingleClick(e, article, btn));
      bar.appendChild(btn);
      setBtnState(article, btn);
      if (browsing) io.observe(article);
    }
  }

  // ---------- 面板 ----------
  const panel = document.createElement('div');
  panel.className = 'xrc-panel';
  panel.innerHTML = `
    <div class="xrc-head">
      <span class="xrc-title">Reply Copilot</span>
      <span>
        <button class="xrc-min" title="收起/展开">–</button>
      </span>
    </div>
    <div class="xrc-body">
      <div class="xrc-row">
        <button class="xrc-toggle xrc-primary">▶ 开始自动浏览</button>
        <button class="xrc-clear">清空草稿</button>
      </div>
      <label class="xrc-stopat">草稿满 <input type="number" min="0" max="200" class="xrc-stopat-input" /> 条自动停止（0 = 不停）</label>
      <label class="xrc-stopat">回复最多 <input type="number" min="5" max="500" class="xrc-maxlen-input" /> 字</label>
      <div class="xrc-status"></div>
      <div class="xrc-list"></div>
      <div class="xrc-row xrc-foot">
        <button class="xrc-approve-all">全部批准</button>
        <button class="xrc-send xrc-primary">发送已批准 (0)</button>
      </div>
    </div>`;
  document.body.appendChild(panel);
  const $ = (s) => panel.querySelector(s);
  $('.xrc-min').onclick = () => panel.classList.toggle('xrc-collapsed');

  const stopAtInput = $('.xrc-stopat-input');
  stopAtInput.addEventListener('change', () => {
    const n = Math.min(200, Math.max(0, Math.round(Number(stopAtInput.value) || 0)));
    stopAtInput.value = n;
    settings.stopAtDrafts = n;
    if (alive()) chrome.storage.local.set({ stopAtDrafts: n }).catch(() => {});
    updateStatus();
  });
  // 回复字数上限：改了之后新生成的草稿按新字数写，已有草稿的计数也跟着更新
  const maxLenInput = $('.xrc-maxlen-input');
  maxLenInput.addEventListener('change', () => {
    const n = Math.min(500, Math.max(5, Math.round(Number(maxLenInput.value) || 25)));
    maxLenInput.value = n;
    settings.maxLen = n;
    if (alive()) chrome.storage.local.set({ maxLen: n }).catch(() => {});
    refreshCounters();
  });

  // ---------- 草稿 ----------
  // status：pending 待决定 / queued 已批准排队中 / sending 发送中 / sent 已发送 / ignored 已忽略
  const drafts = new Map(); // id -> { tweet, card, ta, chk, statusEl, approved, status, ... }
  const seen = new Set();
  const queue = []; // 等待生成草稿的帖子
  const sendQueue = []; // 等待发送的草稿
  const openDrafts = () => [...drafts.values()].filter((d) => d.status === 'pending' || d.status === 'queued');
  const pendingDrafts = () => [...drafts.values()].filter((d) => d.status === 'pending');
  let statusExtra = '';

  // 重要提醒：在面板上多停留一会
  const notify = (text) => toast(text, 6000);

  function updateStatus() {
    const parts = [
      browsing ? '浏览中' : '浏览已停',
      `已看 ${seen.size}`,
      `草稿 ${openDrafts().length}/${draftCap()}`,
      `今日已回复 ${todayCount()}/${settings.dailyLimit}`,
    ];
    if (queue.length) parts.push(`生成排队 ${queue.length}`);
    if (sendQueue.length) parts.push(`待发送 ${sendQueue.length}`);
    if (statusExtra) parts.push(statusExtra);
    $('.xrc-status').textContent = parts.join(' · ');
    if (document.activeElement !== stopAtInput) stopAtInput.value = stopAt();
    if (document.activeElement !== maxLenInput) maxLenInput.value = settings.maxLen;
    const n = pendingDrafts().filter((d) => d.approved).length;
    const sendBtn = $('.xrc-send');
    sendBtn.textContent = sending ? `■ 停止发送 (${sendQueue.length})` : `发送已批准 (${n})`;
    sendBtn.disabled = !sending && n === 0;
  }

  const refreshCounters = () => {
    for (const d of drafts.values()) d.updateCounter?.();
  };

  function setDraftStatus(d, status, label) {
    d.status = status;
    d.statusEl.textContent = label;
    d.card.dataset.status = status;
    const locked = status !== 'pending';
    d.ta.disabled = locked;
    d.chk.disabled = locked;
    updateStatus();
  }

  async function regenerate(d) {
    if (d.status !== 'pending') return;
    d.regenBtn.disabled = true;
    try {
      d.ta.value = await generate(d.tweet);
      d.updateCounter();
      d.statusEl.textContent = '已重写';
    } catch (err) {
      notify(`重写失败：${err.message}`);
    } finally {
      d.regenBtn.disabled = false;
    }
  }

  function ignoreDraft(d) {
    if (d.status === 'sending') return '正在发送，不能忽略';
    setDraftStatus(d, 'ignored', '已忽略');
    d.card.remove();
    drafts.delete(d.tweet.id);
    updateStatus();
    return '已忽略';
  }

  // 批准 = 直接进入发送队列
  function enqueue(d) {
    if (d.status !== 'pending') return d.status === 'queued' ? '已在发送队列中' : '这条草稿已处理';
    const text = d.ta.value.trim();
    if (!text) return '内容为空';
    if (charLen(text) > settings.maxLen) return `超过 ${settings.maxLen} 字，请先修改`;
    if (replied[d.tweet.id]) {
      setDraftStatus(d, 'sent', '已回复过');
      return '这条已经回复过';
    }
    d.approved = true;
    d.chk.checked = true;
    sendQueue.push(d);
    setDraftStatus(d, 'queued', `已批准，排队中（第 ${sendQueue.length} 条）`);
    runSendQueue();
    return `已加入发送队列（第 ${sendQueue.length} 条）`;
  }


  function addDraft(tweet, reply) {
    const d = { tweet, approved: false, status: 'pending' };
    const card = document.createElement('div');
    card.className = 'xrc-card';
    card.dataset.status = 'pending';

    const meta = document.createElement('div');
    meta.className = 'xrc-meta';
    const who = document.createElement('a');
    who.href = tweet.url;
    who.target = '_blank';
    who.textContent = `@${tweet.handle}`;
    const statusEl = document.createElement('span');
    statusEl.className = 'xrc-card-status';
    meta.append(who, statusEl);

    const orig = document.createElement('div');
    orig.className = 'xrc-orig';
    orig.textContent = clip(tweet.text || tweet.quote || tweet.media, 100);

    const ta = document.createElement('textarea');
    ta.value = reply;
    const counter = document.createElement('div');
    counter.className = 'xrc-counter';
    const updateCounter = () => {
      const n = charLen(ta.value);
      counter.textContent = `${n}/${settings.maxLen}`;
      counter.classList.toggle('xrc-over', n > settings.maxLen);
    };
    ta.addEventListener('input', updateCounter);
    updateCounter();

    const row = document.createElement('div');
    row.className = 'xrc-row';
    const label = document.createElement('label');
    label.className = 'xrc-approve';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.onchange = () => {
      d.approved = chk.checked;
      updateStatus();
    };
    label.append(chk, ' 批准');
    row.appendChild(label);
    const mk = (text, fn) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.onclick = fn;
      row.appendChild(b);
      return b;
    };
    mk('自己发', async () => {
      if (d.status !== 'pending') return;
      stopBrowsing();
      const article = findArticleById(tweet.id);
      if (article) {
        article.scrollIntoView({ block: 'center' });
        await sleep(300);
        await fillReply(article, ta.value.trim(), tweet.id);
      } else {
        openIntent(tweet.id, ta.value.trim());
      }
    });
    const regenBtn = mk('重写', () => regenerate(d));
    mk('忽略', () => {
      const r = ignoreDraft(d);
      if (r !== '已忽略') toast(r);
    });

    card.append(meta, orig, ta, counter, row);
    Object.assign(d, { card, ta, chk, statusEl, regenBtn, updateCounter });
    drafts.set(tweet.id, d);
    $('.xrc-list').prepend(card);
    updateStatus();
  }

  $('.xrc-clear').onclick = () => {
    if (sending) return toast('发送中，不能清空');
    drafts.clear();
    queue.length = 0;
    $('.xrc-list').replaceChildren();
    updateStatus();
  };

  $('.xrc-approve-all').onclick = () => {
    for (const d of pendingDrafts()) {
      d.approved = true;
      d.chk.checked = true;
    }
    updateStatus();
  };

  // 回复记录变化时（例如在别的标签页回复了），同步草稿状态
  setInterval(() => {
    for (const d of openDrafts()) {
      if (!replied[d.tweet.id]) continue;
      if (d.status === 'queued') sendQueue.splice(sendQueue.indexOf(d), 1);
      setDraftStatus(d, 'sent', '已回复');
    }
  }, 2000);

  // ---------- 发送队列（只发送批准过的草稿） ----------
  let lastSentAt = 0;
  let nextGap = 0;
  let consecutiveFails = 0;
  const randomGap = () => {
    const min = Number(settings.batchMin) || 30;
    const max = Math.max(min, Number(settings.batchMax) || min);
    return (min + Math.random() * (max - min)) * 1000;
  };

  async function runSendQueue() {
    if (sending) return; // 已在运行，新加入的会被同一个循环发出
    sending = true;
    stopBatch = false;
    updateStatus();
    let sent = 0;
    while (sendQueue.length && !stopBatch && !dead) {
      if (todayCount() >= settings.dailyLimit) {
        notify(`⚠️ 今日已达上限 ${settings.dailyLimit} 条，剩余草稿退回待处理`);
        break;
      }
      const end = lastSentAt + nextGap;
      while (Date.now() < end && !stopBatch) {
        statusExtra = `下一条 ${Math.ceil((end - Date.now()) / 1000)}s`;
        updateStatus();
        await sleep(1000);
      }
      statusExtra = '';
      if (stopBatch) break;
      const d = sendQueue.shift();
      if (!d || d.status !== 'queued') continue; // 被撤回或忽略
      if (replied[d.tweet.id]) {
        setDraftStatus(d, 'sent', '已回复过，跳过');
        continue;
      }
      setDraftStatus(d, 'sending', '发送中…');
      try {
        // 兜底超时：后台万一没回应，不让队列一直卡在「发送中」
        const res = await Promise.race([
          send({ type: 'post', id: d.tweet.id, url: d.tweet.url, text: d.ta.value.trim() }),
          sleep(100000).then(() => {
            const e = new Error('发送超时（100 秒没有结果）');
            e.kind = 'retry';
            throw e;
          }),
        ]);
        markReplied(d.tweet.id);
        setDraftStatus(d, 'sent', res.uncertain ? '可能已发送，请确认' : '已发送 ✓');
        sent++;
        consecutiveFails = 0;
      } catch (err) {
        if (dead) break;
        const kind = err.kind || 'retry';
        d.retries = (d.retries || 0) + 1;
        consecutiveFails++;
        const requeue = (label, gap) => {
          sendQueue.unshift(d);
          setDraftStatus(d, 'queued', label);
          lastSentAt = Date.now();
          nextGap = gap;
        };

        if (kind === 'limit') {
          // 需要你本人处理（验证、登录、X 的每日上限）：整个队列停下
          d.retries--;
          requeue(err.message, 0);
          notify(`🛑 ${err.message}\n发送队列已停止，处理好后在电脑上重新批准即可`);
          toast(`${err.message}，发送队列已停止`, 8000);
          stopBatch = true;
          break;
        }
        if (kind === 'ratelimit' && d.retries <= MAX_RETRIES) {
          requeue(`${err.message}，队列暂停 ${RATE_LIMIT_PAUSE / 60000} 分钟`, RATE_LIMIT_PAUSE);
          notify(`⏸ ${err.message}，发送队列暂停 ${RATE_LIMIT_PAUSE / 60000} 分钟后自动继续。建议把发送间隔调大`);
          continue;
        }
        if (kind === 'retry' && d.retries <= MAX_RETRIES) {
          // 临时问题：放回队首，等待时间逐次加长
          const gap = 30000 * d.retries;
          requeue(`${err.message}，${gap / 1000} 秒后重试（${d.retries}/${MAX_RETRIES}）`, gap);
          if (consecutiveFails < MAX_CONSECUTIVE_FAILS) continue;
        } else {
          d.approved = false;
          d.chk.checked = false;
          setDraftStatus(d, 'pending', `发送失败：${err.message}`);
          d.card.dataset.status = 'failed';
          d.retries = 0;
        }
        if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
          notify(`🛑 连续 ${consecutiveFails} 次发送失败，发送队列已停止。最近一次：${err.message}`);
          toast(`连续 ${consecutiveFails} 次发送失败，队列已停止`, 8000);
          stopBatch = true;
          break;
        }
        lastSentAt = Date.now();
        nextGap = randomGap();
        continue;
      }
      d.retries = 0;
      lastSentAt = Date.now();
      nextGap = randomGap();
    }
    // 停止或达到上限时，队列里剩下的退回待处理
    for (const d of sendQueue.splice(0)) {
      if (d.status !== 'queued') continue;
      d.approved = false;
      d.chk.checked = false;
      setDraftStatus(d, 'pending', '已停止，未发送');
    }
    send({ type: 'senderClose' }).catch(() => {});
    statusExtra = '';
    sending = false;
    updateStatus();
    if (sent) {
      notify(`📤 队列发送完毕：本轮 ${sent} 条，今日 ${todayCount()}/${settings.dailyLimit}`);
    }
  }

  function sendApproved() {
    const list = pendingDrafts().filter((d) => d.approved);
    if (!list.length) return toast('还没有批准的草稿');
    const left = settings.dailyLimit - todayCount();
    if (left <= 0) return toast(`今日已达上限 ${settings.dailyLimit} 条，可在设置里调整`);
    const over = list.filter((d) => charLen(d.ta.value) > settings.maxLen);
    if (over.length) return toast(`有 ${over.length} 条超过 ${settings.maxLen} 字，请先修改`);
    if (!confirm(`将依次发送 ${list.length} 条已批准的回复（今日剩余额度 ${left}），每条间隔 ${settings.batchMin}–${settings.batchMax} 秒，会弹出小窗口自动发送。\n发送期间请不要关闭此页面。确定吗？`))
      return;
    for (const d of list) {
      const r = enqueue(d);
      if (!r.startsWith('已加入')) toast(`@${d.tweet.handle}：${r}`);
    }
  }

  $('.xrc-send').onclick = () => {
    if (sending) {
      stopBatch = true;
      statusExtra = '正在停止…';
      updateStatus();
    } else sendApproved();
  };

  // ---------- 自动浏览 ----------
  let scrollTimer = null;
  let pauseUntil = 0;
  let working = false;

  function matchesKeywords(text) {
    const kws = (settings.keywords || '')
      .split(/[,，]/)
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
    if (!kws.length) return true;
    const t = text.toLowerCase();
    return kws.some((k) => t.includes(k));
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const id = getTweetId(e.target);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        // 本地先过滤，省 token
        if (replied[id] || drafts.has(id)) continue;
        const tweet = getTweetData(e.target);
        const me = myHandle();
        if (me && tweet.handle.toLowerCase() === me) continue;
        if (charLen(tweet.text) < 15 || isAd(e.target)) continue;
        if (!matchesKeywords(`${tweet.text} ${tweet.quote}`)) continue;
        pauseUntil = Date.now() + 1500 + Math.random() * 2500; // 停下来"读"一会
        if (settings.autoDraft && openDrafts().length + queue.length < draftCap()) {
          queue.push(tweet);
          processQueue();
        }
      }
      updateStatus();
    },
    { threshold: 0.6 }
  );

  async function processQueue() {
    if (working) return;
    working = true;
    while (queue.length && !dead) {
      const tweet = queue.shift();
      updateStatus();
      if (replied[tweet.id] || drafts.has(tweet.id)) continue;
      try {
        addDraft(tweet, await generate(tweet));
        checkStopAt();
      } catch (err) {
        toast(err.message);
        if (/API Key|余额|401|402/.test(err.message)) {
          queue.length = 0;
          stopBrowsing();
        }
      }
    }
    working = false;
    updateStatus();
  }

  // 浏览时最多攒多少条待处理草稿
  const stopAt = () => Number(settings.stopAtDrafts) || 0;
  // 设了「草稿满 N 条停止」就以它为准；设为 0 时才用设置页的「草稿上限」
  const draftCap = () => (stopAt() > 0 ? stopAt() : Number(settings.maxDrafts) || 20);

  function checkStopAt() {
    if (browsing && stopAt() > 0 && openDrafts().length >= stopAt()) {
      stopBrowsing();
      notify(`🛑 草稿已满 ${stopAt()} 条，已自动停止浏览`);
    }
  }

  // 返回空字符串表示成功，否则返回原因
  function startBrowsing() {
    let err = '';
    if (dead) err = '扩展已失效，请刷新页面';
    else if (browsing) err = '已经在浏览中';
    else if (stopAt() > 0 && openDrafts().length >= stopAt())
      err = `已有 ${openDrafts().length} 条待处理草稿（停止阈值 ${stopAt()}），请先处理或调高阈值`;
    if (err) {
      toast(err);
      return err;
    }
    browsing = true;
    $('.xrc-toggle').textContent = '⏸ 暂停浏览';
    document.querySelectorAll(SEL.tweet).forEach((a) => io.observe(a));
    scrollTimer = setInterval(() => {
      if (document.hidden || Date.now() < pauseUntil) return;
      if (document.querySelector(SEL.dialog)) return stopBrowsing(); // 打开弹窗时暂停
      window.scrollBy(0, Number(settings.scrollSpeed) || 2);
    }, 16);
    updateStatus();
    return '';
  }

  function stopBrowsing() {
    browsing = false;
    clearInterval(scrollTimer);
    io.disconnect();
    $('.xrc-toggle').textContent = '▶ 开始自动浏览';
    updateStatus();
  }

  $('.xrc-toggle').onclick = () => (browsing ? stopBrowsing() : startBrowsing());

  // 页面被切到后台/最小化时，浏览器会暂停渲染，自动浏览没法继续 —— 提醒一下
  let hiddenTimer = null;
  document.addEventListener('visibilitychange', () => {
    clearTimeout(hiddenTimer);
    if (!document.hidden || !browsing) return;
    hiddenTimer = setTimeout(() => {
      if (!document.hidden || !browsing) return;
      // 切回来时能在面板上看到
      notify('⚠️ X 页面被切到后台，自动浏览已暂停，切回这个标签页即可继续');
    }, 15000);
  });

  // ---------- 监听页面变化（节流） ----------
  let scanQueued = false;
  new MutationObserver(() => {
    if (scanQueued || dead) return;
    scanQueued = true;
    setTimeout(() => {
      scanQueued = false;
      try {
        injectButtons();
        refreshButtons(); // X 会复用 DOM 节点，按钮状态需要重新对一遍
      } catch (e) {
        console.warn('[XRC]', e);
      }
    }, 200);
  }).observe(document.body, { childList: true, subtree: true });

  panelReady = true;
  injectButtons();
  updateStatus();

  // 兜底：万一 X 跳转时丢了 xrc_job 标记，发送窗口里的原帖页仍能接到任务
  if (/\/status\/\d+/.test(location.pathname)) {
    send({ type: 'job' })
      .then((r) => {
        if (r.job) {
          panel.remove();
          runReplyJob(r.job);
        }
      })
      .catch(() => {});
  }
})();
