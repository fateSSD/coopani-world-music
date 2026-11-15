/*
 * 一起听歌 · 「她此刻」面板。
 *
 * 契约：默认导出 `{ panels: { now: { mount(ctx) } } }`。
 * `ctx.root` 是唯一挂载点，`ctx.invoke('snapshot')` 取数据，`ctx.interval` 是宿主管的定时器
 * （**不要用裸 setInterval** —— 切页面时宿主清不掉，会在后台跑一整天）。
 *
 * 这一页只读。想让她记态度，走 `music_tag` 的 `verdict` 参数 ——
 * 那是她自己在听的时候下的判断，不该由这个页面上的按钮替她下。
 */

const TEXT = {
  zh: {
    eyebrow: '她此刻',
    playingNow: '在放',
    notPlaying: '没在放',
    playerOff: '播放器没连上',
    unknownTrack: '未知曲目',
    unknownArtist: '未知歌手',

    howSheHears: '她怎么听这首',
    feelHard: '烈',
    feelSoft: '柔',
    feelOld: '旧',
    feelOdd: '怪',
    feelPlain: '淡',
    genreLabel: '曲风',
    noGenre: '说不上是什么',
    sourceLabel: '这是从',
    srcTag: '她自己标过的',
    srcAlbum: '专辑标签',
    srcArtist: '同歌手别的歌',
    srcGuess: '歌名猜的',
    srcAudio: '声音特征',
    srcNone: '没有依据，只是没听出什么',

    herTake: '她喜不喜欢',
    like: '喜欢',
    likeMeh: '说不上',
    likeNo: '不喜欢',
    notSaid: '还没说过',
    notSaidWhy: '她听着的时候自己会说 —— 顺便标一句就有了，不用你替她判断。',
    whyLabel: '她说',

    wantsTitle: '她想听什么',
    noWants: '暂时没有。她自己搜到喜欢的会记下来。',
    wantCount: (n) => `一共 ${n} 首`,

    lampsTitle: '灯',
    lampsIntro: '扩展名旁边那几盏灯现在是这样：',
    lampOn: '正常',
    lampOff: '没启用',
    lampErr: '有问题',
    lampLoading: '正在连',
    helpTitle: '那几盏灯怎么看？',
    helpOn: '绿',
    helpOnDesc: '上一次是好的，正常。',
    helpOff: '灰',
    helpOffDesc: '没启用，不是坏了 —— 比如深听关着、或者还没开过播放器。不用管。',
    helpErr: '红',
    helpErrDesc: '配好了但用不了，要去处理。',

    todayTitle: '今天',
    todayTracks: (n) => `${n} 首`,
    todayTime: (s) => s,

    fbLead: '有 bug，或者想让她能干什么？',
    fbBug: '复制诊断信息',
    fbWant: '复制诊断信息（想加东西）',
    fbOpenBug: '开 Issues 报 bug ↗',
    fbOpenWant: '开 Issues 提需求 ↗',
    fbCopied: '已复制，粘过去就行',
    fbAddr: '仓库：',
    fbWhy: '按钮只负责把版本和当前状态复制到剪贴板（不带任何身份信息）。'
      + '点右边的链接去 GitHub 开一条，把复制的内容粘在正文里。',
    fail: '读不到',
  },
  en: {
    eyebrow: 'Her now',
    playingNow: 'Playing',
    notPlaying: 'Nothing playing',
    playerOff: 'player not connected',
    unknownTrack: 'Unknown track',
    unknownArtist: 'unknown artist',

    howSheHears: 'How she hears this',
    feelHard: 'hard',
    feelSoft: 'soft',
    feelOld: 'old',
    feelOdd: 'odd',
    feelPlain: 'plain',
    genreLabel: 'Genre',
    noGenre: 'cannot place it',
    sourceLabel: 'based on',
    srcTag: 'her own tag',
    srcAlbum: 'album tags',
    srcArtist: 'same artist',
    srcGuess: 'title guess',
    srcAudio: 'audio features',
    srcNone: 'no evidence — she just cannot place it',

    herTake: 'Does she like it',
    like: 'likes it',
    likeMeh: 'no strong feeling',
    likeNo: 'does not like it',
    notSaid: 'not said yet',
    notSaidWhy: 'She says it herself while listening — you do not have to decide for her.',
    whyLabel: 'she says',

    wantsTitle: 'What she wants to hear',
    noWants: 'Nothing yet. She writes down what she finds.',
    wantCount: (n) => `${n} total`,

    lampsTitle: 'Lamps',
    lampsIntro: 'The dots next to the extension name right now:',
    lampOn: 'ok',
    lampOff: 'not enabled',
    lampErr: 'problem',
    lampLoading: 'connecting',
    helpTitle: 'What do those dots mean?',
    helpOn: 'Green',
    helpOnDesc: 'last time worked. Normal.',
    helpOff: 'Grey',
    helpOffDesc: 'not enabled — that is not a fault. Nothing to do.',
    helpErr: 'Red',
    helpErrDesc: 'configured but not working. Hover the dot for the reason.',

    todayTitle: 'Today',
    todayTracks: (n) => `${n} tracks`,
    todayTime: (s) => s,

    fbLead: 'A bug, or something you want her to do?',
    fbBug: 'Copy diagnostics',
    fbWant: 'Copy diagnostics (feature request)',
    fbOpenBug: 'Open an issue ↗',
    fbOpenWant: 'Request a feature ↗',
    fbCopied: 'copied — just paste it',
    fbAddr: 'Repo: ',
    fbWhy: 'The button only copies the version and current state to your clipboard. '
      + 'Use the link to open a GitHub issue and paste it in the body.',
    fail: 'cannot read',
  },
};

const el = (doc, tag, cls, text) => {
  const node = doc.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
};

/** `mm:ss`。没有时长就返回空串，别显示 0:00。 */
const clock = (sec) => {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

function mount(ctx) {
  const doc = ctx.root.ownerDocument ?? document;
  const t = TEXT[String(ctx.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'];

  const app = el(doc, 'div', 'mu-panel');
  ctx.root.append(app);

  /* ---------------- 头部：在放什么 ---------------- */
  const head = el(doc, 'header', 'mu-head');
  const eyebrow = el(doc, 'p', 'mu-eyebrow', t.eyebrow);
  const title = el(doc, 'h1', 'mu-title', '—');
  const sub = el(doc, 'p', 'mu-sub', '');
  head.append(eyebrow, title, sub);

  const bar = el(doc, 'div', 'mu-bar');
  const barFill = el(doc, 'div', 'mu-bar-fill');
  bar.append(barFill);
  head.append(bar);

  /* ---------------- 三块卡 ---------------- */
  const hearCard = el(doc, 'section', 'mu-card');
  const takeCard = el(doc, 'section', 'mu-card');
  const wantCard = el(doc, 'section', 'mu-card');
  const cards = el(doc, 'div', 'mu-cols');
  cards.append(hearCard, takeCard, wantCard);

  /* ---------------- 灯 ---------------- */
  const lampCard = el(doc, 'section', 'mu-card');
  const helpBox = el(doc, 'details', 'mu-help');

  /* ---------------- 反馈 ---------------- */
  const fbBox = el(doc, 'section', 'mu-fb');

  const foot = el(doc, 'footer', 'mu-foot', '');

  app.append(head, cards, lampCard, helpBox, fbBox, foot);

  /* ---------------- 工具 ---------------- */
  const copyText = (text) => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text);
      }
    } catch (e) { /* 落到下面 */ }
    try {
      const ta = doc.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      doc.body.append(ta);
      ta.select();
      doc.execCommand('copy');
      ta.remove();
    } catch (e) { /* 复制不了就算了 */ }
    return Promise.resolve();
  };

  /**
   * 灯的说明 + **当前状态**。
   *
   * 跟别的扩展不一样的一处：这里不只讲「绿灰红是什么意思」，
   * 还把**每盏灯现在的状态和原因直接列出来**。灯在扩展名旁边，鼠标悬停能看到，
   * 但没人知道要悬停 —— 与其教他悬停，不如把答案搬到他要找的地方。
   */
  const HELP = el(doc, 'div');
  {
    const ul = el(doc, 'ul', 'mu-legend');
    for (const [color, k, d] of [
      ['var(--ok, #2f855a)', 'helpOn', 'helpOnDesc'],
      ['var(--ink-dim, #9ca3af)', 'helpOff', 'helpOffDesc'],
      ['var(--danger, #c0392b)', 'helpErr', 'helpErrDesc'],
    ]) {
      const li = el(doc, 'li');
      const dot = el(doc, 'span', 'mu-dot');
      dot.style.background = color;
      li.append(dot, el(doc, 'b', null, t[k]), doc.createTextNode('　' + t[d]));
      ul.append(li);
    }
    HELP.append(ul);
  }
  helpBox.append(el(doc, 'summary', null, t.helpTitle), HELP);

  const lampWord = (state) => (state === 'online' ? t.lampOn
    : state === 'error' ? t.lampErr
      : state === 'loading' ? t.lampLoading : t.lampOff);

  const drawLamps = (lamps) => {
    lampCard.innerHTML = '';
    lampCard.append(el(doc, 'h3', null, t.lampsTitle));
    lampCard.append(el(doc, 'p', 'mu-muted', t.lampsIntro));
    if (!lamps || !lamps.length) {
      lampCard.append(el(doc, 'p', 'mu-muted', '—'));
      return;
    }
    const ul = el(doc, 'ul', 'mu-lamps');
    for (const l of lamps) {
      const li = el(doc, 'li', 'mu-lamp');
      const dot = el(doc, 'span', 'mu-dot');
      dot.dataset.state = l.state || 'offline';
      const name = el(doc, 'b', 'mu-lamp-name', l.label || '');
      const word = el(doc, 'span', 'mu-lamp-word', lampWord(l.state));
      word.dataset.state = l.state || 'offline';
      li.append(dot, name, word);
      if (l.hint) li.append(el(doc, 'div', 'mu-lamp-hint', l.hint));
      ul.append(li);
    }
    lampCard.append(ul);
  };

  const drawFeedback = (fb) => {
    fbBox.innerHTML = '';
    if (!fb || !fb.repo) { fbBox.remove(); return; }
    fbBox.append(el(doc, 'p', 'mu-fb-lead', t.fbLead));

    const row = el(doc, 'div', 'mu-fb-row');
    for (const kind of ['bug', 'want']) {
      const btn = el(doc, 'button', 'mu-btn', kind === 'bug' ? t.fbBug : t.fbWant);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        const old = btn.textContent;
        copyText(fb.digest || '').then(() => {
          btn.textContent = t.fbCopied;
          setTimeout(() => { btn.textContent = old; }, 1800);
        });
      }, { signal: ctx.signal });
      row.append(btn);
    }
    /* 只有 https 会被宿主交给系统浏览器 —— 这是唯一能真的点出去的一类链接。 */
    for (const kind of ['bug', 'want']) {
      const a = el(doc, 'a', 'mu-btn', kind === 'bug' ? t.fbOpenBug : t.fbOpenWant);
      a.href = `${fb.repo}/issues/new?title=${encodeURIComponent(`${kind === 'bug' ? '[bug]' : '[want]'} v${fb.version || ''}`)}`;
      a.target = '_blank';
      a.rel = 'noreferrer';
      row.append(a);
    }
    fbBox.append(row);

    const addr = el(doc, 'div', 'mu-fb-addr');
    addr.append(el(doc, 'span', null, t.fbAddr), el(doc, 'code', null, fb.repo));
    fbBox.append(addr);
    fbBox.append(el(doc, 'p', 'mu-fb-why', t.fbWhy));
  };

  /* ---------------- 渲染 ---------------- */
  const render = (d) => {
    if (!d) return;
    const now = d.now;

    /* 头部 */
    if (now) {
      title.textContent = `《${now.title || t.unknownTrack}》`;
      sub.textContent = [now.artist || t.unknownArtist, now.album, now.app].filter(Boolean).join('　·　');
      const tot = now.durSec;
      const cur = now.posSec;
      if (typeof tot === 'number' && tot > 0 && typeof cur === 'number') {
        barFill.style.width = `${Math.max(1, Math.min(100, Math.round((cur / tot) * 100)))}%`;
        head.dataset.playing = '1';
        sub.textContent += `　·　${clock(cur)} / ${clock(tot)}`;
      } else {
        barFill.style.width = '0%';
        head.dataset.playing = '0';
      }
    } else {
      title.textContent = d.playerUp ? t.notPlaying : t.playerOff;
      sub.textContent = '';
      barFill.style.width = '0%';
      head.dataset.playing = '0';
    }

    /* 她怎么听这首 */
    hearCard.innerHTML = '';
    hearCard.append(el(doc, 'h3', null, t.howSheHears));
    if (!d.vibe || !now) {
      hearCard.append(el(doc, 'p', 'mu-muted', '—'));
    } else {
      const feelKey = { hard: 'feelHard', soft: 'feelSoft', old: 'feelOld', odd: 'feelOdd', plain: 'feelPlain' }[d.vibe.feel] || 'feelPlain';
      const feelRow = el(doc, 'div', 'mu-feel');
      feelRow.append(el(doc, 'span', 'mu-feel-word', t[feelKey]));
      if (d.vibe.genre) {
        feelRow.append(el(doc, 'span', 'mu-genre', d.vibe.genre));
      }
      hearCard.append(feelRow);

      const srcMap = {
        tag: 'srcTag', album: 'srcAlbum', artist: 'srcArtist',
        guess: 'srcGuess', audio: 'srcAudio', none: 'srcNone',
      };
      const src = el(doc, 'p', 'mu-src', `${t.sourceLabel}：${t[srcMap[d.vibe.source] || 'srcNone']}`);
      hearCard.append(src);
      if (!d.vibe.genre) hearCard.append(el(doc, 'p', 'mu-muted', t.noGenre));
    }

    /* 她喜不喜欢 */
    takeCard.innerHTML = '';
    takeCard.append(el(doc, 'h3', null, t.herTake));
    if (!now) {
      takeCard.append(el(doc, 'p', 'mu-muted', '—'));
    } else if (d.like) {
      const wordKey = d.like.verdict === 'like' ? 'like' : d.like.verdict === 'meh' ? 'likeMeh' : 'likeNo';
      const big = el(doc, 'div', 'mu-verdict');
      big.dataset.verdict = d.like.verdict;
      big.textContent = t[wordKey];
      takeCard.append(big);
      if (d.like.why) {
        takeCard.append(el(doc, 'p', 'mu-why', `「${d.like.why}」`));
      }
    } else {
      takeCard.append(el(doc, 'div', 'mu-verdict', t.notSaid));
      takeCard.append(el(doc, 'p', 'mu-muted', t.notSaidWhy));
    }

    /* 她想听什么 */
    wantCard.innerHTML = '';
    wantCard.append(el(doc, 'h3', null, t.wantsTitle));
    const ws = d.wants || [];
    if (!ws.length) {
      wantCard.append(el(doc, 'p', 'mu-muted', t.noWants));
    } else {
      const ul = el(doc, 'ul', 'mu-wants');
      for (const w of ws) {
        const li = el(doc, 'li');
        li.append(el(doc, 'span', null, w.title || ''));
        if (w.artist) li.append(el(doc, 'span', 'mu-artist', w.artist));
        ul.append(li);
      }
      wantCard.append(ul);
    }

    drawLamps(d.lamps);

    /* 反馈只画一次（版本和仓库是常量） */
    if (!fbBox.childElementCount) drawFeedback(d.feedback);

    const bits = [`v${d.version || ''}`];
    if (d.today && d.today.count) bits.push(`${t.todayTitle} ${t.todayTracks(d.today.count)}`);
    if (d.today && d.today.msText) bits.push(d.today.msText);
    foot.textContent = bits.filter(Boolean).join('　·　');
  };

  const fail = (err) => {
    title.textContent = `${t.fail}：${err instanceof Error ? err.message : String(err)}`;
  };

  const refresh = async () => {
    try {
      render(await ctx.invoke('snapshot'));
    } catch (err) {
      fail(err);
    }
  };

  void refresh();
  /* 3 秒一轮：播放器那边本来就按秒推，再快也没用。 */
  ctx.interval(() => { void refresh(); }, 3000);
}

export default {
  panels: {
    now: { mount },
  },
};
