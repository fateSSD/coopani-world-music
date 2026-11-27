/*
 * 一起听歌 · 「她此刻」面板（唱片听歌台布局）。
 *
 * 契约：默认导出 `{ panels: { now: { mount(ctx) } } }`。
 * `ctx.root` 是唯一挂载点，`ctx.invoke('snapshot')` 取数据，`ctx.interval` 是宿主管的定时器
 * （**不要用裸 setInterval** —— 切页面时宿主清不掉，会在后台跑一整天）。
 *
 * 这一页只读（形象包安装按钮是唯一写动作）。想让她记态度，走 `music_tag` 的 `verdict` 参数 ——
 * 那是她自己在听的时候下的判断，不该由这个页面上的按钮替她下。
 */

/** 作者的 QQ 群。反馈栏和简介写的是同一个号，改这里一处就够。 */
const QQ_GROUP = '284525159';

const TEXT = {
  zh: {
    playingNow: '正在放',
    notPlaying: '没在放',
    playerOff: '播放器没连上',
    unknownTrack: '未知曲目',
    unknownArtist: '未知歌手',
    idleHint: '放首歌试试 —— 她认出歌名与路数后，会把听感写在这里。',

    howSheHears: '她怎么听这首',
    feelHard: '烈',
    feelSoft: '柔',
    feelOld: '旧',
    feelOdd: '怪',
    feelPlain: '淡',
    noGenre: '说不上曲风',
    sourceLabel: '依据',
    srcTag: '她自己标过的',
    srcAlbum: '专辑标签',
    srcArtist: '同歌手别的歌',
    srcGuess: '歌名猜的',
    srcAudio: '声音特征',
    srcNone: '暂无依据',

    herTake: '这首她喜不喜欢',
    like: '喜欢',
    likeMeh: '说不上',
    likeNo: '不喜欢',
    notSaid: '还没说过',
    notSaidWhy: '听着的时候她自己会说，不用替她决定。',

    wantsTitle: '她想听什么',
    wantsSub: '播过自动划掉',
    noWants: '暂时没有。她自己搜出来想听的会挂在这里，放过之后自动划掉。',
    wantCount: (n) => `共 ${n} 首`,
    openTrack: '去听 ↗',

    likesTitle: '她喜欢听什么',
    likesSub: '听过心动留存',
    noLikes: '暂时没有。她听完觉得喜欢的歌会留在这里。',
    likeCount: (n) => `共 ${n} 首`,

    drawerTitle: '状态详情 · 形象包 · 反馈',
    lampsTitle: '运行状态',
    figTitle: '形象包',
    figInstall: '装形象包',
    figReinstall: '重装形象包',
    figInstalling: '正在装…',
    figNote: '装完再去换装页把她选成这个形象 —— 装好和用上是两步。重装会整格重写，包坏了就用它。',
    lampsIntro: '扩展名旁边那几盏灯现在的明细：',
    lampOn: '正常',
    lampOff: '未启用',
    lampErr: '异常',
    lampLoading: '连接中',
    helpTitle: '灯色说明',
    helpOn: '绿',
    helpOnDesc: '上一次是好的，正常。',
    helpOff: '灰',
    helpOffDesc: '没启用，不是坏了（比如深听关着、或还没开播放器）。',
    helpErr: '红',
    helpErrDesc: '配好了但用不了，需要处理。',

    todayPrefix: '今天',
    todayTracks: (n) => `${n} 首`,
    todayEmpty: '今天还没开始',

    fbLead: '有 bug，或者想让她能干什么？',
    fbBug: '复制诊断信息',
    fbWant: '复制诊断信息（提建议）',
    fbOpenBug: '开 Issues 报 bug ↗',
    fbOpenWant: '开 Issues 提需求 ↗',
    fbCopied: '已复制 ✓',
    fbAddr: '仓库：',
    fbGroupLead: 'QQ 群：',
    fbWhy: '按钮只把版本和当前状态复制到剪贴板（不带任何身份信息），点右边链接粘进 GitHub Issue 正文即可。',
    fail: '读不到',
  },
  en: {
    playingNow: 'Playing',
    notPlaying: 'Nothing playing',
    playerOff: 'Player not connected',
    unknownTrack: 'Unknown track',
    unknownArtist: 'Unknown artist',
    idleHint: 'Play a track — once she recognizes it, her take will show up here.',

    howSheHears: 'How she hears this',
    feelHard: 'hard',
    feelSoft: 'soft',
    feelOld: 'old',
    feelOdd: 'odd',
    feelPlain: 'plain',
    noGenre: 'no genre placed',
    sourceLabel: 'Basis',
    srcTag: 'her own tag',
    srcAlbum: 'album tags',
    srcArtist: 'same artist',
    srcGuess: 'title guess',
    srcAudio: 'audio features',
    srcNone: 'no evidence yet',

    herTake: 'How she feels about this',
    like: 'likes it',
    likeMeh: 'no strong feeling',
    likeNo: 'does not like it',
    notSaid: 'not said yet',
    notSaidWhy: 'She says it herself while listening — no need to decide for her.',

    wantsTitle: 'What she wants to hear',
    wantsSub: 'clears after play',
    noWants: 'Nothing yet. Tracks she wants to hear appear here and clear once played.',
    wantCount: (n) => `${n} total`,
    openTrack: 'Open ↗',

    likesTitle: 'What she likes',
    likesSub: 'favorites kept',
    noLikes: 'Nothing yet. Tracks she likes while listening stay here.',
    likeCount: (n) => `${n} total`,

    drawerTitle: 'Status · Figure Pack · Feedback',
    lampsTitle: 'Status details',
    figTitle: 'Figure pack',
    figInstall: 'Install figure pack',
    figReinstall: 'Install again',
    figInstalling: 'Installing…',
    figNote: 'Installing is step one — still pick it on the dress-up page. Installing again rewrites the folder.',
    lampsIntro: 'Details for each status indicator:',
    lampOn: 'ok',
    lampOff: 'off',
    lampErr: 'error',
    lampLoading: 'connecting',
    helpTitle: 'Indicator legend',
    helpOn: 'Green',
    helpOnDesc: 'working normally.',
    helpOff: 'Grey',
    helpOffDesc: 'not enabled (not a fault).',
    helpErr: 'Red',
    helpErrDesc: 'configured but failing.',

    todayPrefix: 'Today',
    todayTracks: (n) => `${n} tracks`,
    todayEmpty: 'Nothing today yet',

    fbLead: 'Found a bug or want something new?',
    fbBug: 'Copy diagnostics',
    fbWant: 'Copy diagnostics (request)',
    fbOpenBug: 'Open issue ↗',
    fbOpenWant: 'Request feature ↗',
    fbCopied: 'Copied ✓',
    fbAddr: 'Repo: ',
    fbGroupLead: 'QQ group: ',
    fbWhy: 'Copies version and current state to clipboard only, then paste into the GitHub issue body.',
    fail: 'cannot read',
  },
};

const SVG_NS = 'http://www.w3.org/2000/svg';

const el = (doc, tag, cls, text) => {
  const node = doc.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
};

const svgIcon = (doc, kind) => {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('mu-ico');

  const path = (d) => {
    const p = doc.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  };

  if (kind === 'queue') {
    path('M2.5 4h7.5M2.5 8h6M2.5 12h4.5M11.5 11V4.5l2.5-.8');
    const c = doc.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', '10.3');
    c.setAttribute('cy', '11.5');
    c.setAttribute('r', '1.4');
    svg.append(c);
  } else if (kind === 'heart') {
    path('M8 13.5S2.5 9.9 2.5 6A3 3 0 0 1 8 4.2 3 3 0 0 1 13.5 6c0 3.9-5.5 7.5-5.5 7.5Z');
  } else if (kind === 'alert') {
    path('M8 2.4 14 13H2L8 2.4ZM8 6.4v3.1M8 11.3h.01');
  }
  return svg;
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

  /* ---------------- 1. 头部唱片听歌台 ---------------- */
  const hero = el(doc, 'section', 'mu-hero');
  hero.dataset.playing = '0';

  const heroTop = el(doc, 'div', 'mu-hero-top');
  const livePill = el(doc, 'div', 'mu-live-pill');
  const eq = el(doc, 'span', 'mu-eq');
  eq.append(el(doc, 'span'), el(doc, 'span'), el(doc, 'span'));
  const idleDot = el(doc, 'span', 'mu-live-dot');
  const liveWord = el(doc, 'span', 'mu-live-word', t.playerOff);
  const playerChip = el(doc, 'span', 'mu-player-chip', '');
  livePill.append(eq, idleDot, liveWord, playerChip);

  const heroRight = el(doc, 'div', 'mu-hero-right');
  const todayPill = el(doc, 'span', 'mu-stat-pill', t.todayEmpty);
  const verChip = el(doc, 'span', 'mu-ver-chip', '');
  heroRight.append(todayPill, verChip);
  heroTop.append(livePill, heroRight);

  const stage = el(doc, 'div', 'mu-stage');
  const disc = el(doc, 'div', 'mu-disc');
  const discInner = el(doc, 'div', 'mu-disc-inner');
  const discCore = el(doc, 'div', 'mu-disc-core');
  disc.append(discInner, discCore);

  const trackMeta = el(doc, 'div', 'mu-track-meta');
  const title = el(doc, 'h1', 'mu-title', '—');
  const sub = el(doc, 'p', 'mu-sub', '');
  const progressRow = el(doc, 'div', 'mu-progress');
  const bar = el(doc, 'div', 'mu-bar');
  const barFill = el(doc, 'div', 'mu-bar-fill');
  bar.append(barFill);
  const timeText = el(doc, 'span', 'mu-time', '');
  progressRow.append(bar, timeText);
  trackMeta.append(title, sub, progressRow);
  stage.append(disc, trackMeta);

  const takeStrip = el(doc, 'div', 'mu-take-strip');
  const takeGrid = el(doc, 'div', 'mu-take-grid');
  const hearCell = el(doc, 'div', 'mu-take-cell');
  const takeCell = el(doc, 'div', 'mu-take-cell');
  takeGrid.append(hearCell, takeCell);
  const idleNote = el(doc, 'p', 'mu-idle-note', t.idleHint);
  takeStrip.append(takeGrid, idleNote);

  hero.append(heroTop, stage, takeStrip);

  /* ---------------- 2. 双容器歌单（她想听什么 / 她喜欢听什么） ---------------- */
  const lists = el(doc, 'div', 'mu-lists');
  const wantCard = el(doc, 'section', 'mu-card mu-list-card');
  const likeListCard = el(doc, 'section', 'mu-card mu-list-card');
  lists.append(wantCard, likeListCard);

  /* ---------------- 3. 状态胶囊条 + 异常告警 + 形象包横幅 + 折叠抽屉 ---------------- */
  const statusBar = el(doc, 'div', 'mu-status-bar');
  const alertBanner = el(doc, 'div', 'mu-alert-banner');
  alertBanner.hidden = true;

  const figBanner = el(doc, 'section', 'mu-card mu-fig-banner');
  figBanner.hidden = true;

  const drawer = el(doc, 'details', 'mu-drawer');
  const drawerSum = el(doc, 'summary', 'mu-drawer-sum');
  drawerSum.append(
    el(doc, 'span', 'mu-drawer-title', t.drawerTitle),
    el(doc, 'span', 'mu-drawer-badge', `${t.fbGroupLead}${QQ_GROUP}`),
  );
  const drawerBody = el(doc, 'div', 'mu-drawer-body');
  const lampDetailSlot = el(doc, 'div', 'mu-drawer-section');
  const figDrawerSlot = el(doc, 'div', 'mu-drawer-section');
  const fbSlot = el(doc, 'div', 'mu-drawer-section mu-fb');
  drawerBody.append(lampDetailSlot, figDrawerSlot, fbSlot);
  drawer.append(drawerSum, drawerBody);

  app.append(hero, lists, statusBar, alertBanner, figBanner, drawer);

  /* ---------------- 工具与增量缓存 ---------------- */
  let lastWantKey = '';
  let lastLikeKey = '';
  let lastLampKey = '';
  let lastFigKey = '';
  let figBusy = false;

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

  const lampWord = (state) => (state === 'online' ? t.lampOn
    : state === 'error' ? t.lampErr
      : state === 'loading' ? t.lampLoading : t.lampOff);

  const drawLamps = (lamps) => {
    const list = Array.isArray(lamps) ? lamps : [];
    const key = JSON.stringify(list);
    if (key === lastLampKey) return;
    lastLampKey = key;

    statusBar.innerHTML = '';
    alertBanner.innerHTML = '';
    const errors = [];

    for (const l of list) {
      const st = l.state || 'offline';
      const pill = el(doc, 'span', 'mu-lamp-pill');
      pill.dataset.state = st;
      if (l.hint) pill.title = `${l.label || ''}：${l.hint}`;
      const dot = el(doc, 'span', 'mu-dot');
      dot.dataset.state = st;
      pill.append(dot, el(doc, 'span', 'mu-lamp-pill-name', l.label || ''), el(doc, 'span', 'mu-lamp-pill-state', lampWord(st)));
      statusBar.append(pill);
      if (st === 'error') errors.push(l);
    }

    if (errors.length) {
      alertBanner.hidden = false;
      const headRow = el(doc, 'div', 'mu-alert-head');
      headRow.append(svgIcon(doc, 'alert'), el(doc, 'span', null, errors.map((e) => e.label).filter(Boolean).join(' · ')));
      alertBanner.append(headRow);
      for (const e of errors) {
        if (e.hint) alertBanner.append(el(doc, 'p', 'mu-alert-msg', `${e.label ? `${e.label}：` : ''}${e.hint}`));
      }
    } else {
      alertBanner.hidden = true;
    }

    lampDetailSlot.innerHTML = '';
    lampDetailSlot.append(el(doc, 'h3', 'mu-sec-title', t.lampsTitle));
    lampDetailSlot.append(el(doc, 'p', 'mu-muted', t.lampsIntro));
    if (!list.length) {
      lampDetailSlot.append(el(doc, 'p', 'mu-muted', '—'));
    } else {
      const ul = el(doc, 'ul', 'mu-lamps');
      for (const l of list) {
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
      lampDetailSlot.append(ul);
    }

    const legend = el(doc, 'ul', 'mu-legend');
    for (const [dotState, k, d] of [
      ['online', 'helpOn', 'helpOnDesc'],
      ['offline', 'helpOff', 'helpOffDesc'],
      ['error', 'helpErr', 'helpErrDesc'],
    ]) {
      const li = el(doc, 'li');
      const dot = el(doc, 'span', 'mu-dot');
      dot.dataset.state = dotState;
      li.append(dot, el(doc, 'b', null, t[k]), doc.createTextNode('　' + t[d]));
      legend.append(li);
    }
    lampDetailSlot.append(legend);
  };

  /** 渲染形象包区块（需要重点提示时挂在横幅，正常/已占时收在抽屉里）。 */
  const renderFigureInto = (container, fig, prominent) => {
    container.innerHTML = '';
    if (!fig) return;
    const headRow = el(doc, 'div', 'mu-fig-head');
    headRow.append(el(doc, 'h3', 'mu-sec-title', t.figTitle));
    const occupied = fig.status === 'occupied';
    const isActionable = fig.status === 'missing' || fig.status === 'failed' || fig.status === 'outdated';
    const btn = el(
      doc,
      'button',
      prominent || isActionable ? 'mu-btn mu-btn-primary' : 'mu-btn',
      fig.status === 'missing' ? t.figInstall : t.figReinstall,
    );
    btn.type = 'button';
    btn.disabled = occupied;
    btn.addEventListener('click', async () => {
      if (btn.disabled || figBusy) return;
      figBusy = true;
      btn.disabled = true;
      btn.textContent = t.figInstalling;
      try {
        const snap = await ctx.invoke('installFigure');
        figBusy = false;
        lastFigKey = '';
        render(snap);
      } catch (err) {
        figBusy = false;
        fail(err);
        btn.disabled = occupied;
        btn.textContent = fig.status === 'missing' ? t.figInstall : t.figReinstall;
      }
    }, { signal: ctx.signal });
    headRow.append(btn);
    container.append(headRow);
    container.append(el(doc, 'p', 'mu-fig-msg', fig.message || ''));
    container.append(el(doc, 'p', 'mu-fig-note', t.figNote));
  };

  const drawFigure = (fig) => {
    if (figBusy) return;
    const key = fig ? `${fig.status}|${fig.message || ''}` : 'none';
    if (key === lastFigKey) return;
    lastFigKey = key;

    if (!fig) {
      figBanner.hidden = true;
      figBanner.innerHTML = '';
      figDrawerSlot.hidden = true;
      figDrawerSlot.innerHTML = '';
      return;
    }

    const needBanner = fig.status === 'missing' || fig.status === 'failed' || fig.status === 'outdated';
    if (needBanner) {
      figBanner.hidden = false;
      renderFigureInto(figBanner, fig, true);
      figDrawerSlot.hidden = true;
      figDrawerSlot.innerHTML = '';
    } else {
      figBanner.hidden = true;
      figBanner.innerHTML = '';
      figDrawerSlot.hidden = false;
      renderFigureInto(figDrawerSlot, fig, false);
    }
  };

  const drawFeedback = (fb) => {
    fbSlot.innerHTML = '';
    if (!fb || !fb.repo) {
      fbSlot.hidden = true;
      return;
    }
    fbSlot.hidden = false;
    fbSlot.append(el(doc, 'h3', 'mu-sec-title', t.fbLead));

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
    for (const kind of ['bug', 'want']) {
      const a = el(doc, 'a', 'mu-btn', kind === 'bug' ? t.fbOpenBug : t.fbOpenWant);
      a.href = `${fb.repo}/issues/new?title=${encodeURIComponent(`${kind === 'bug' ? '[bug]' : '[want]'} v${fb.version || ''}`)}`;
      a.target = '_blank';
      a.rel = 'noreferrer';
      row.append(a);
    }
    fbSlot.append(row);

    const addr = el(doc, 'div', 'mu-fb-addr');
    addr.append(el(doc, 'span', null, t.fbAddr), el(doc, 'code', null, fb.repo));
    fbSlot.append(addr);
    const grp = el(doc, 'div', 'mu-fb-addr');
    grp.append(el(doc, 'span', null, t.fbGroupLead), el(doc, 'code', null, QQ_GROUP));
    fbSlot.append(grp);
    fbSlot.append(el(doc, 'p', 'mu-fb-why', t.fbWhy));
  };

  const drawSongListCard = (card, cfg) => {
    card.innerHTML = '';

    const headRow = el(doc, 'div', 'mu-card-head');
    const titleGroup = el(doc, 'div', 'mu-card-title-wrap');
    titleGroup.append(svgIcon(doc, cfg.icon), el(doc, 'h3', null, cfg.heading));
    if (cfg.subLabel) titleGroup.append(el(doc, 'span', 'mu-card-sub', cfg.subLabel));
    headRow.append(titleGroup);
    if (cfg.total > 0) {
      headRow.append(el(doc, 'span', 'mu-count-pill', cfg.countText));
    }
    card.append(headRow);

    if (!cfg.items.length) {
      const empty = el(doc, 'div', 'mu-empty');
      empty.append(el(doc, 'p', 'mu-muted', cfg.emptyText));
      card.append(empty);
      return;
    }

    const scroll = el(doc, 'div', 'mu-list-scroll');
    const list = el(doc, cfg.ordered ? 'ol' : 'ul', 'mu-rows');

    cfg.items.forEach((item, idx) => {
      const li = el(doc, 'li', 'mu-row');

      if (cfg.ordered) {
        const rank = el(
          doc,
          'span',
          idx === 0 ? 'mu-rank mu-rank-first' : 'mu-rank',
          String(idx + 1).padStart(2, '0'),
        );
        li.append(rank);
      } else {
        li.append(el(doc, 'span', 'mu-heart-badge', '♥'));
      }

      const main = el(doc, 'div', 'mu-row-main');
      const line1 = el(doc, 'div', 'mu-row-line');
      line1.append(el(doc, 'span', 'mu-row-title', item.title || t.unknownTrack));
      if (item.artist) line1.append(el(doc, 'span', 'mu-artist', item.artist));
      main.append(line1);
      if (item.why) main.append(el(doc, 'div', 'mu-row-why', item.why));
      li.append(main);

      if (cfg.withLinks && typeof item.url === 'string' && /^https:\/\//i.test(item.url)) {
        const a = el(doc, 'a', 'mu-open-btn', t.openTrack);
        a.href = item.url;
        a.target = '_blank';
        a.rel = 'noreferrer';
        li.append(a);
      }

      list.append(li);
    });

    scroll.append(list);
    card.append(scroll);
  };

  /* ---------------- 渲染 ---------------- */
  const render = (d) => {
    if (!d) return;
    const now = d.now;
    const playing = Boolean(now);
    hero.dataset.playing = playing ? '1' : '0';

    /* 顶部元信息条 */
    if (playing) {
      liveWord.textContent = t.playingNow;
      playerChip.textContent = now.app || '';
      playerChip.hidden = !now.app;
    } else {
      liveWord.textContent = d.playerUp ? t.notPlaying : t.playerOff;
      playerChip.textContent = '';
      playerChip.hidden = true;
    }

    const todayBits = [];
    if (d.today && d.today.count) todayBits.push(`${t.todayPrefix} ${t.todayTracks(d.today.count)}`);
    if (d.today && d.today.msText) todayBits.push(d.today.msText);
    todayPill.textContent = todayBits.length ? todayBits.join(' · ') : t.todayEmpty;
    verChip.textContent = d.version ? `v${d.version}` : '';
    verChip.hidden = !d.version;

    /* 唱片舞台 */
    if (playing) {
      title.textContent = `《${now.title || t.unknownTrack}》`;
      sub.textContent = [now.artist || t.unknownArtist, now.album].filter(Boolean).join('　·　');
      sub.hidden = !sub.textContent;
      const tot = now.durSec;
      const cur = now.posSec;
      if (typeof tot === 'number' && tot > 0 && typeof cur === 'number') {
        barFill.style.width = `${Math.max(1, Math.min(100, Math.round((cur / tot) * 100)))}%`;
        timeText.textContent = `${clock(cur)} / ${clock(tot)}`;
        timeText.hidden = false;
      } else {
        barFill.style.width = '0%';
        timeText.textContent = '';
        timeText.hidden = true;
      }
    } else {
      title.textContent = d.playerUp ? t.notPlaying : t.playerOff;
      sub.textContent = '';
      sub.hidden = true;
      barFill.style.width = '0%';
      timeText.textContent = '';
      timeText.hidden = true;
    }

    /* 当前单曲她的反应 */
    hearCell.innerHTML = '';
    takeCell.innerHTML = '';
    if (!playing) {
      takeGrid.hidden = true;
      idleNote.hidden = false;
    } else {
      takeGrid.hidden = false;
      idleNote.hidden = true;

      hearCell.append(el(doc, 'div', 'mu-take-label', t.howSheHears));
      if (!d.vibe) {
        hearCell.append(el(doc, 'p', 'mu-muted', '—'));
      } else {
        const feelKey = { hard: 'feelHard', soft: 'feelSoft', old: 'feelOld', odd: 'feelOdd', plain: 'feelPlain' }[d.vibe.feel] || 'feelPlain';
        const feelRow = el(doc, 'div', 'mu-take-val');
        const feelPill = el(doc, 'span', 'mu-feel-pill', t[feelKey]);
        feelPill.dataset.feel = d.vibe.feel || 'plain';
        feelRow.append(feelPill);
        feelRow.append(el(doc, 'span', 'mu-genre', d.vibe.genre || t.noGenre));
        hearCell.append(feelRow);

        const srcMap = {
          tag: 'srcTag', album: 'srcAlbum', artist: 'srcArtist',
          guess: 'srcGuess', audio: 'srcAudio', none: 'srcNone',
        };
        hearCell.append(el(doc, 'p', 'mu-take-sub', `${t.sourceLabel}：${t[srcMap[d.vibe.source] || 'srcNone']}`));
      }

      takeCell.append(el(doc, 'div', 'mu-take-label', t.herTake));
      if (d.like) {
        const wordKey = d.like.verdict === 'like' ? 'like' : d.like.verdict === 'meh' ? 'likeMeh' : 'likeNo';
        const verdictRow = el(doc, 'div', 'mu-take-val');
        const pill = el(doc, 'span', 'mu-verdict-pill', t[wordKey]);
        pill.dataset.verdict = d.like.verdict;
        verdictRow.append(pill);
        takeCell.append(verdictRow);
        if (d.like.why) {
          takeCell.append(el(doc, 'p', 'mu-take-quote', `「${d.like.why}」`));
        }
      } else {
        const verdictRow = el(doc, 'div', 'mu-take-val');
        const pill = el(doc, 'span', 'mu-verdict-pill', t.notSaid);
        pill.dataset.verdict = 'none';
        verdictRow.append(pill);
        takeCell.append(verdictRow);
        takeCell.append(el(doc, 'p', 'mu-take-sub', t.notSaidWhy));
      }
    }

    /* 双容器歌单：只在内容变化时重绘，保住滚动位置 */
    const ws = Array.isArray(d.wants) ? d.wants : [];
    const wantTotal = typeof d.wantTotal === 'number' ? d.wantTotal : ws.length;
    const wantKey = JSON.stringify([wantTotal, ws]);
    if (wantKey !== lastWantKey) {
      lastWantKey = wantKey;
      drawSongListCard(wantCard, {
        icon: 'queue',
        heading: t.wantsTitle,
        subLabel: t.wantsSub,
        total: wantTotal,
        countText: t.wantCount(wantTotal),
        items: ws,
        emptyText: t.noWants,
        ordered: true,
        withLinks: true,
      });
    }

    const ls = Array.isArray(d.likes) ? d.likes : [];
    const likeTotal = typeof d.likeTotal === 'number' ? d.likeTotal : ls.length;
    const likeKey = JSON.stringify([likeTotal, ls]);
    if (likeKey !== lastLikeKey) {
      lastLikeKey = likeKey;
      drawSongListCard(likeListCard, {
        icon: 'heart',
        heading: t.likesTitle,
        subLabel: t.likesSub,
        total: likeTotal,
        countText: t.likeCount(likeTotal),
        items: ls,
        emptyText: t.noLikes,
        ordered: false,
        withLinks: false,
      });
    }

    drawLamps(d.lamps);
    drawFigure(d.figure);

    if (!fbSlot.childElementCount) drawFeedback(d.feedback);
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
