/* =========================================================
   Möbius Music · 应用逻辑
   ========================================================= */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const audio = $('audio');

  function bootError(msg) {
    const m = document.getElementById('libMeta');
    if (m) m.textContent = '启动错误：' + msg;
  }
  window.addEventListener('error', (e) => bootError(e.message || '未知错误'));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    bootError((r && r.message) || String(r) || '未知错误');
  });

  const state = {
    tracks: [],
    filtered: [],
    sort: 'added',
    query: '',
    currentId: null,
    queue: [],
    qIndex: -1,
    shuffle: false,
    repeat: 'off',
    importing: false,
    importCancel: false,
    seeking: false,
  };

  const audioCache = new Map(); // id -> Blob
  const coverUrls = new Map(); // id -> objectURL（播放页大图）
  let currentAudioUrl = null;
  let pendingSeek = 0;
  let toastTimer = 0;
  let searchTimer = 0;

  /* ---------------------------------------------------------- helpers */

  const fmtTime = (sec) => {
    if (!sec || !isFinite(sec) || sec < 0) return '0:00';
    const s = Math.floor(sec % 60);
    const m = Math.floor(sec / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  const fmtBytes = (n) => {
    if (!n) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  };

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `t${Date.now()}${Math.random().toString(16).slice(2)}`);

  const byId = (id) => state.tracks.find((t) => t.id === id) || null;

  const shuffleArr = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const tick = () => new Promise((r) => setTimeout(r, 16));

  function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error('timeout:' + (label || '')));
      }, ms);
      promise.then(
        (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
        (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } },
      );
    });
  }

  function toast(msg) {
    const el = $('toast');
    $('toastText').textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  /* ------------------------------------------------------- app icon */

  function makeAppleIcon() {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 180;
      const g = c.getContext('2d');
      g.fillStyle = '#080a12';
      g.fillRect(0, 0, 180, 180);
      const grd = g.createLinearGradient(10, 10, 170, 170);
      grd.addColorStop(0, '#7de8ff');
      grd.addColorStop(0.52, '#a78bfa');
      grd.addColorStop(1, '#f472b6');
      g.strokeStyle = grd;
      g.lineWidth = 10;
      g.beginPath();
      g.arc(90, 90, 46, 0.2, Math.PI * 2 - 0.2);
      g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.92)';
      g.beginPath();
      g.arc(68, 112, 9, 0, Math.PI * 2);
      g.fill();
      g.fillRect(75, 66, 5, 46);
      g.beginPath();
      g.moveTo(75, 66);
      g.quadraticCurveTo(106, 60, 110, 78);
      g.quadraticCurveTo(96, 70, 80, 74);
      g.closePath();
      g.fill();
      const link = document.createElement('link');
      link.rel = 'apple-touch-icon';
      link.sizes = '180x180';
      link.href = c.toDataURL('image/png');
      document.head.appendChild(link);
    } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------- rendering */

  function sortAndFilter() {
    const q = state.query.trim().toLowerCase();
    let arr = state.tracks.filter((t) => {
      if (!q) return true;
      return [t.title, t.artist, t.album, t.name].some((s) => (s || '').toLowerCase().includes(q));
    });
    if (state.sort === 'title') {
      arr.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN', { numeric: true }));
    } else if (state.sort === 'artist') {
      arr.sort((a, b) => (a.artist || '').localeCompare(b.artist || '', 'zh-Hans-CN') || a.title.localeCompare(b.title, 'zh-Hans-CN'));
    } else {
      arr.sort((a, b) => b.addedAt - a.addedAt || a.title.localeCompare(b.title, 'zh-Hans-CN'));
    }
    return arr;
  }

  function updateMeta() {
    const total = state.tracks.reduce((s, t) => s + (t.size || 0), 0);
    $('libMeta').textContent = state.tracks.length ? `${state.tracks.length} 首 · ${fmtBytes(total)}` : '还没有音乐';
  }

  function render() {
    state.filtered = sortAndFilter();
    updateMeta();

    const list = $('list');
    list.textContent = '';
    const frag = document.createDocumentFragment();
    state.filtered.forEach((t) => frag.appendChild(trackRow(t)));
    list.appendChild(frag);

    const noTracks = state.tracks.length === 0;
    $('empty').classList.toggle('show', noTracks);
    $('toolbar').classList.toggle('hidden', noTracks);
    if (!noTracks && state.filtered.length === 0) {
      const d = document.createElement('div');
      d.className = 'noResult';
      d.textContent = '没有找到匹配的歌曲';
      list.appendChild(d);
    }

    document.querySelectorAll('.chip[data-sort]').forEach((c) => {
      c.classList.toggle('active', c.dataset.sort === state.sort);
    });
    document.body.classList.toggle('playing', !!state.currentId && !audio.paused);
    document.body.classList.toggle('paused', audio.paused);
  }

  function trackRow(t) {
    const row = document.createElement('div');
    row.className = 'track' + (t.id === state.currentId ? ' playing' : '');
    row.dataset.id = t.id;

    const cover = document.createElement('div');
    cover.className = 'tCover';
    if (t.thumb) {
      const img = document.createElement('img');
      img.src = t.thumb;
      img.alt = '';
      img.loading = 'lazy';
      cover.appendChild(img);
    } else {
      const n = document.createElement('span');
      n.className = 'note';
      n.textContent = '♪';
      cover.appendChild(n);
    }

    const text = document.createElement('div');
    text.className = 'tText';
    const title = document.createElement('div');
    title.className = 'tTitle';
    title.textContent = t.title;
    if (t.id === state.currentId && !audio.paused) {
      const eq = document.createElement('span');
      eq.className = 'eq';
      eq.innerHTML = '<i></i><i></i><i></i>';
      title.appendChild(eq);
    }
    const artist = document.createElement('div');
    artist.className = 'tArtist';
    artist.textContent = [t.artist, t.album].filter(Boolean).join(' · ') || '未知歌手';
    text.append(title, artist);

    const time = document.createElement('div');
    time.className = 'tTime';
    time.textContent = t.duration ? fmtTime(t.duration) : '--:--';

    const more = document.createElement('button');
    more.className = 'tMore';
    more.setAttribute('aria-label', '更多');
    more.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5.5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18.5" cy="12" r="1.6"/></svg>';
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      trackMenu(t);
    });

    row.append(cover, text, time, more);
    row.addEventListener('click', () => {
      const ids = state.filtered.map((x) => x.id);
      state.queue = state.shuffle ? [t.id, ...shuffleArr(ids.filter((x) => x !== t.id))] : ids;
      state.qIndex = state.queue.indexOf(t.id);
      if (state.qIndex < 0) { state.queue.unshift(t.id); state.qIndex = 0; }
      playTrack(t.id);
    });
    return row;
  }

  function updateRows() {
    document.querySelectorAll('.track').forEach((row) => {
      const on = row.dataset.id === state.currentId;
      row.classList.toggle('playing', on);
      const title = row.querySelector('.tTitle');
      const eq = row.querySelector('.eq');
      if (on && !audio.paused) {
        if (!eq && title) {
          const e = document.createElement('span');
          e.className = 'eq';
          e.innerHTML = '<i></i><i></i><i></i>';
          title.appendChild(e);
        }
      } else if (eq) {
        eq.remove();
      }
    });
  }

  /* --------------------------------------------------------- playing */

  function playTrack(id) {
    const t = byId(id);
    if (!t) return;
    state.currentId = id;

    let blob = audioCache.get(id);
    if (!blob) {
      updateNowUI();
      MusicDB.getAudio(t).then((b) => {
        if (!b) { toast('音频数据丢失，请重新导入'); return; }
        audioCache.set(id, b);
        if (state.currentId === id) startAudio(t, b);
      }).catch(() => toast('读取音频失败'));
      return;
    }
    startAudio(t, blob);
  }

  function startAudio(t, blob) {
    if (currentAudioUrl) {
      try { URL.revokeObjectURL(currentAudioUrl); } catch (e) { /* ignore */ }
      currentAudioUrl = null;
    }
    const restorePos = pendingSeek;
    pendingSeek = 0;

    currentAudioUrl = URL.createObjectURL(blob);
    audio.src = currentAudioUrl;
    if (restorePos > 0.5) {
      audio.addEventListener('loadedmetadata', () => {
        try { audio.currentTime = Math.min(restorePos, (audio.duration || restorePos) - 0.5); } catch (e) { /* ignore */ }
      }, { once: true });
    } else {
      try { audio.currentTime = 0; } catch (e) { /* ignore */ }
    }
    updateNowUI();
    const p = audio.play();
    if (p && p.catch) {
      p.catch(() => {
        toast('点击播放按钮开始播放');
        updatePlayState();
      });
    }
  }

  function updatePlayState() {
    const playing = !audio.paused && !!state.currentId;
    document.body.classList.toggle('playing', playing);
    document.body.classList.toggle('paused', !playing);
    updateRows();
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'; } catch (e) { /* ignore */ }
    }
  }

  function updateNowUI() {
    const t = state.currentId ? byId(state.currentId) : null;
    const mini = $('mini');

    if (!t) {
      mini.classList.add('hidden');
      $('miniTitle').textContent = '未在播放';
      $('miniArtist').textContent = '—';
      $('miniCover').innerHTML = '<span class="note">♪</span>';
      $('nowTitle').textContent = '未在播放';
      $('nowArtist').textContent = '从音乐库选择一首歌';
      $('coverBox').classList.remove('hasImg');
      $('coverImg').removeAttribute('src');
      $('playerBg').classList.remove('on');
      $('playerBg').style.backgroundImage = '';
      $('seek').value = '0';
      $('seek').style.setProperty('--p', '0%');
      $('timeCur').textContent = '0:00';
      $('timeDur').textContent = '0:00';
      $('playerLabel').textContent = '正在播放';
      return;
    }

    mini.classList.remove('hidden');
    $('miniTitle').textContent = t.title;
    $('miniArtist').textContent = t.artist || '未知歌手';
    const miniCover = $('miniCover');
    miniCover.innerHTML = '';
    if (t.thumb) {
      const img = new Image();
      img.src = t.thumb;
      img.alt = '';
      miniCover.appendChild(img);
    } else {
      const n = document.createElement('span');
      n.className = 'note';
      n.textContent = '♪';
      miniCover.appendChild(n);
    }

    $('nowTitle').textContent = t.title;
    $('nowArtist').textContent = [t.artist || '未知歌手', t.album].filter(Boolean).join(' · ');
    $('playerLabel').textContent = '正在播放';

    const box = $('coverBox');
    const img = $('coverImg');
    if (t.thumb) {
      img.src = t.thumb;
      box.classList.add('hasImg');
    } else {
      img.removeAttribute('src');
      box.classList.remove('hasImg');
    }
    $('playerBg').classList.remove('on');

    if (t.hasCover) {
      const cached = coverUrls.get(t.id);
      const apply = (url) => {
        if (state.currentId !== t.id) return;
        img.src = url;
        box.classList.add('hasImg');
        $('playerBg').style.backgroundImage = `url("${url}")`;
        $('playerBg').classList.add('on');
      };
      if (cached) apply(cached);
      else {
        MusicDB.getCover(t.id).then((blob) => {
          if (!blob) return;
          const url = URL.createObjectURL(blob);
          coverUrls.set(t.id, url);
          apply(url);
        }).catch(() => {});
      }
    }

    updateMediaSession(t);
    updatePlayState();
  }

  function updateMediaSession(t) {
    if (!('mediaSession' in navigator)) return;
    try {
      const art = t.thumb ? [{ src: t.thumb, sizes: '96x96', type: 'image/jpeg' }] : [];
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title,
        artist: t.artist || '未知歌手',
        album: t.album || 'Möbius Music',
        artwork: art,
      });
    } catch (e) { /* ignore */ }
  }

  function togglePlay() {
    if (!state.currentId) {
      playAll();
      return;
    }
    if (!audio.src) {
      playTrack(state.currentId);
      return;
    }
    if (audio.paused) {
      const p = audio.play();
      if (p && p.catch) p.catch(() => toast('无法播放，请重试'));
    } else {
      audio.pause();
    }
  }

  function playAll(forceShuffle) {
    if (!state.filtered.length) {
      toast(state.tracks.length ? '没有可播放的歌曲' : '先导入音乐');
      return;
    }
    if (forceShuffle) state.shuffle = true;
    const ids = state.shuffle ? shuffleArr(state.filtered.map((t) => t.id)) : state.filtered.map((t) => t.id);
    state.queue = ids;
    state.qIndex = 0;
    $('btnShuffle').classList.toggle('on', state.shuffle);
    playTrack(ids[0]);
  }

  function next(auto) {
    if (!state.queue.length) return;
    if (auto && state.repeat === 'one') {
      audio.currentTime = 0;
      audio.play().catch(() => {});
      return;
    }
    let i = state.qIndex + 1;
    if (i >= state.queue.length) {
      if (state.repeat === 'all' || !auto) i = 0;
      else {
        audio.pause();
        audio.currentTime = 0;
        updatePlayState();
        return;
      }
    }
    state.qIndex = i;
    playTrack(state.queue[i]);
  }

  function prev() {
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    if (!state.queue.length) return;
    let i = state.qIndex - 1;
    if (i < 0) i = state.repeat === 'all' ? state.queue.length - 1 : 0;
    state.qIndex = i;
    playTrack(state.queue[i]);
  }

  function toggleShuffle() {
    state.shuffle = !state.shuffle;
    $('btnShuffle').classList.toggle('on', state.shuffle);
    localStorage.setItem('mm.shuffle', state.shuffle ? '1' : '0');
    if (state.shuffle && state.queue.length) {
      const cur = state.queue[state.qIndex];
      const rest = state.queue.filter((x) => x !== cur);
      state.queue = cur ? [cur, ...shuffleArr(rest)] : shuffleArr(rest);
      state.qIndex = 0;
    } else if (!state.shuffle && state.currentId) {
      const ids = state.filtered.map((t) => t.id);
      const cur = state.currentId;
      if (!ids.includes(cur)) ids.unshift(cur);
      state.queue = ids;
      state.qIndex = Math.max(0, ids.indexOf(cur));
    }
    toast(state.shuffle ? '随机播放已开启' : '随机播放已关闭');
  }

  function cycleRepeat() {
    state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
    localStorage.setItem('mm.repeat', state.repeat);
    updateRepeatUI();
    toast({ off: '循环已关闭', all: '列表循环', one: '单曲循环' }[state.repeat]);
  }

  function updateRepeatUI() {
    const btn = $('btnRepeat');
    btn.classList.toggle('on', state.repeat !== 'off');
    btn.classList.toggle('repeat-one', state.repeat === 'one');
    btn.title = { off: '循环关闭', all: '列表循环', one: '单曲循环' }[state.repeat];
  }

  /* ---------------------------------------------------------- seek UI */

  function updateProgress() {
    if (state.seeking) return;
    const dur = audio.duration;
    if (!dur || !isFinite(dur)) return;
    const p = Math.min(1, audio.currentTime / dur);
    const seek = $('seek');
    seek.value = String(Math.round(p * 1000));
    seek.style.setProperty('--p', `${(p * 100).toFixed(2)}%`);
    $('timeCur').textContent = fmtTime(audio.currentTime);
    $('timeDur').textContent = fmtTime(dur);
    const bar = $('miniProgress').firstElementChild;
    if (bar) bar.style.width = `${(p * 100).toFixed(1)}%`;

    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState) {
      const now = Date.now();
      if (now - (updateProgress._t || 0) > 1000) {
        updateProgress._t = now;
        try {
          navigator.mediaSession.setPositionState({ duration: dur, position: Math.min(audio.currentTime, dur), playbackRate: audio.playbackRate || 1 });
        } catch (e) { /* ignore */ }
      }
    }
  }

  function bindSeek() {
    const seek = $('seek');
    seek.addEventListener('pointerdown', () => { state.seeking = true; });
    seek.addEventListener('input', () => {
      const dur = audio.duration || 0;
      const val = Number(seek.value) / 1000;
      seek.style.setProperty('--p', `${(val * 100).toFixed(2)}%`);
      $('timeCur').textContent = fmtTime(val * dur);
    });
    const commit = () => {
      if (!state.seeking) return;
      const dur = audio.duration || 0;
      const val = Number(seek.value) / 1000;
      if (dur) {
        try { audio.currentTime = val * dur; } catch (e) { /* ignore */ }
      }
      state.seeking = false;
    };
    seek.addEventListener('change', commit);
    seek.addEventListener('pointerup', commit);
  }

  /* ---------------------------------------------------------- import */

  /** 用同一个 audio 元素探测时长，2.5s 超时；失败返回 0，绝不阻塞导入 */
  function probeDuration(el, blob, timeout) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        el.onloadedmetadata = null;
        el.onerror = null;
        try { el.removeAttribute('src'); el.load(); } catch (e) { /* ignore */ }
        try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
        resolve(v);
      };
      const timer = setTimeout(() => finish(0), timeout || 2500);
      el.preload = 'metadata';
      el.onloadedmetadata = () => finish(isFinite(el.duration) ? el.duration : 0);
      el.onerror = () => finish(0);
      el.src = url;
    });
  }

  let fillerRunning = false;
  let fillerPending = false;
  let probeEl = null;

  async function fillDurations() {
    if (fillerRunning) {
      fillerPending = true;
      return;
    }
    fillerRunning = true;
    if (!probeEl) probeEl = new Audio();

    const attempted = new Set();
    let fails = 0;

    for (;;) {
      if (state.importing || state.importCancel) break;
      const t = state.tracks.find((x) => !attempted.has(x.id) && (!x.duration || !isFinite(x.duration)));
      if (!t) break;
      attempted.add(t.id);

      let blob = audioCache.get(t.id);
      if (!blob) {
        try { blob = await MusicDB.getAudio(t); } catch (e) { blob = null; }
      }
      if (!blob) continue;

      const sec = await probeDuration(probeEl, blob, 2500);
      if (sec > 0) {
        fails = 0;
        t.duration = sec;
        try { await MusicDB.updateMeta(t); } catch (e) { /* ignore */ }
        updateRowDuration(t.id, sec);
      } else if (++fails >= 8) {
        break;
      }
      await new Promise((r) => setTimeout(r, 60));
    }

    fillerRunning = false;
    if (fillerPending) {
      fillerPending = false;
      fillDurations();
    }
  }

  function updateRowDuration(id, sec) {
    document.querySelectorAll('.track').forEach((row) => {
      if (row.dataset.id !== id) return;
      const el = row.querySelector('.tTime');
      if (el) el.textContent = fmtTime(sec);
    });
  }

  function showImport(total) {
    $('importOverlay').classList.add('open');
    $('importSub').textContent = `共 ${total} 个文件`;
    $('importBar').style.width = '0%';
  }

  function updateImport(done, total, label) {
    $('importBar').style.width = `${Math.round((done / total) * 100)}%`;
    $('importSub').textContent = label ? `${label}（${done}/${total}）` : `${done} / ${total}`;
  }

  function hideImport() {
    $('importOverlay').classList.remove('open');
  }

  /** 入库：音频按 2MB 分片写入（MusicDB.put 内部处理） */
  async function storeTrack(track, file, cover) {
    try {
      await MusicDB.put(track, file, cover);
      return file;
    } catch (e) {
      const text = String((e && (e.name + ' ' + e.message)) || '');
      if (/quota|storage|exceed/i.test(text)) throw e;
      // 分片写入失败后已 abort/重置连接，用干净连接、不带封面再试一次
      MusicDB.reset();
      await MusicDB.put(track, file, null);
      return file;
    }
  }

  async function showImportResult(added, skipped, failed, errors, quotaHit, cancelled) {
    const sheet = sheetBase('导入结果');
    const lines = [`成功 ${added} 首`];
    if (skipped) lines.push(`跳过重复 ${skipped} 首`);
    if (failed) lines.push(`失败 ${failed} 首`);
    if (quotaHit) lines.push('存储空间不足');
    if (cancelled) lines.push('已取消（已完成保留）');

    try {
      const est = await MusicDB.estimate();
      if (est.quota) lines.push(`存储 ${fmtBytes(est.usage)} / ${fmtBytes(est.quota)}`);
    } catch (e) { /* ignore */ }

    const hint = document.createElement('div');
    hint.className = 'sheetHint';
    hint.textContent = lines.join(' · ');
    sheet.appendChild(hint);

    if (errors.length) {
      const list = document.createElement('div');
      list.className = 'errList';
      errors.slice(0, 8).forEach((er) => {
        const row = document.createElement('div');
        row.className = 'errRow';
        row.textContent = `${er.file} — ${er.error}`;
        list.appendChild(row);
      });
      sheet.appendChild(list);
    }

    const dbStuck = errors.some((er) => /db-timeout|timeout:db|db-abort|db-error/i.test(er.error));
    if (dbStuck) {
      const resetBtn = document.createElement('button');
      resetBtn.className = 'sheetAction danger';
      resetBtn.innerHTML = ICONS.trash + '<span>重置本地数据库（会清空已导入歌曲）</span>';
      resetBtn.addEventListener('click', confirmResetDb);
      sheet.appendChild(resetBtn);
    }

    const btn = document.createElement('button');
    btn.className = 'sheetCancel';
    btn.textContent = '知道了';
    btn.addEventListener('click', closeSheet);
    sheet.appendChild(btn);
    openSheet();
  }

  function confirmResetDb() {
    const sheet = sheetBase('重置本地数据库');
    const hint = document.createElement('div');
    hint.className = 'sheetHint';
    hint.textContent = '当数据库卡死时可以用这个恢复。注意：本机所有已导入的歌曲都会被删除，需要重新导入。';
    sheet.appendChild(hint);
    sheet.appendChild(sheetButton(ICONS.trash, '确认重置并重新加载', async () => {
      try { await MusicDB.destroy(); } catch (e) { /* ignore */ }
      try { localStorage.removeItem('mm.last'); localStorage.removeItem('mm.pos'); } catch (e) { /* ignore */ }
      location.reload();
    }, { danger: true }));
    const cancel = document.createElement('button');
    cancel.className = 'sheetCancel';
    cancel.textContent = '取消';
    cancel.addEventListener('click', closeSheet);
    sheet.appendChild(cancel);
    openSheet();
  }

  async function importFiles(fileList) {
    if (state.importing) return;
    const files = Array.from(fileList).filter((f) => MusicTags.isAudioFile(f));
    if (!files.length) {
      toast('没有找到可导入的音频文件');
      return;
    }
    state.importing = true;
    state.importCancel = false;
    showImport(files.length);

    const MAX_SIZE = 200 * 1024 * 1024;
    const MAX_COVER = 6 * 1024 * 1024;
    const existing = new Set(state.tracks.map((t) => t.fp));
    let added = 0;
    let skipped = 0;
    let failed = 0;
    let quotaHit = false;
    const errors = [];

    for (let i = 0; i < files.length; i++) {
      if (state.importCancel) break;
      const f = files[i];

      if (f.size > MAX_SIZE) {
        failed++;
        errors.push({ file: f.name, error: '文件超过 200MB' });
        updateImport(i + 1, files.length, `跳过超大文件：${f.name}`);
        await tick();
        continue;
      }
      if (!f.size) {
        failed++;
        errors.push({ file: f.name, error: '文件为空或仍在 iCloud（请先下载到本机）' });
        updateImport(i + 1, files.length, `跳过空文件：${f.name}`);
        await tick();
        continue;
      }

      // 探测文件是否真的可读（iCloud 占位文件会在读取时失败）
      try {
        await f.slice(0, 1).arrayBuffer();
      } catch (readErr) {
        failed++;
        errors.push({ file: f.name, error: '无法读取（可能还在 iCloud，请先下载到本机）' });
        updateImport(i + 1, files.length, `无法读取：${f.name}`);
        await tick();
        continue;
      }

      const fp = `${f.name}|${f.size}|${f.lastModified}`;
      if (existing.has(fp)) {
        skipped++;
        updateImport(i + 1, files.length, `跳过重复：${f.name}`);
        await tick();
        continue;
      }

      try {
        updateImport(i + 1, files.length, `读取 ${f.name}`);
        const tags = await withTimeout(MusicTags.parseTags(f), 10000, 'tags');
        const cover = tags.cover && tags.cover.size <= MAX_COVER ? tags.cover : null;
        let thumb = null;
        if (cover) {
          thumb = await withTimeout(MusicTags.makeThumb(cover, 96), 8000, 'thumb').catch(() => null);
        }
        const duration = tags.duration && isFinite(tags.duration) && tags.duration > 0 ? tags.duration : 0;

        const track = {
          id: uid(),
          fp,
          name: MusicTags.repairText(f.name),
          title: MusicTags.repairText((tags.title || MusicTags.fromFilename(f.name).title || f.name).trim()),
          artist: MusicTags.repairText((tags.artist || '').trim()),
          album: MusicTags.repairText((tags.album || '').trim()),
          duration,
          size: f.size,
          mime: f.type || 'audio/mpeg',
          addedAt: Date.now(),
          thumb: thumb || null,
          hasCover: !!cover && !!thumb,
        };

        updateImport(i + 1, files.length, `保存 ${f.name}`);
        const stored = await storeTrack(track, f, cover);
        audioCache.set(track.id, stored);
        state.tracks.push(track);
        existing.add(fp);
        added++;
        updateImport(i + 1, files.length, `已导入 ${f.name}`);
      } catch (e) {
        failed++;
        const text = String((e && (e.name + ' ' + e.message)) || e);
        errors.push({ file: `${f.name} (${fmtBytes(f.size)})`, error: text.slice(0, 160) });
        if (/quota|storage|exceed/i.test(text)) {
          quotaHit = true;
          break;
        }
        updateImport(i + 1, files.length, `失败：${f.name}`);
      }
      await tick();
    }

    const cancelled = state.importCancel;
    state.importing = false;
    state.importCancel = false;
    hideImport();
    render();

    if (added) {
      try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* ignore */ }
    }

    const bits = [`导入 ${added} 首`];
    if (skipped) bits.push(`跳过 ${skipped} 首重复`);
    if (failed) bits.push(`${failed} 首失败`);
    if (failed > 0 || quotaHit) {
      showImportResult(added, skipped, failed, errors, quotaHit, cancelled);
    } else if (cancelled) {
      toast(`已停止导入，保存 ${added} 首`);
    } else {
      toast(bits.join(' · '));
    }

    if (added) fillDurations();
  }

  /* ------------------------------------------------------------ menu */

  function sheetBase(title) {
    const sheet = $('sheet');
    sheet.textContent = '';
    const grip = document.createElement('div');
    grip.className = 'sheetGrip';
    sheet.appendChild(grip);
    if (title) {
      const h = document.createElement('div');
      h.className = 'sheetTitle';
      h.textContent = title;
      sheet.appendChild(h);
    }
    return sheet;
  }

  function sheetButton(iconSvg, label, onClick, opts) {
    const b = document.createElement('button');
    b.className = 'sheetAction' + (opts && opts.danger ? ' danger' : '');
    if (iconSvg) b.innerHTML = iconSvg;
    const span = document.createElement('span');
    span.textContent = label;
    b.appendChild(span);
    if (opts && opts.sub) {
      const s = document.createElement('span');
      s.className = 'sub';
      s.textContent = opts.sub;
      b.appendChild(s);
    }
    b.addEventListener('click', () => {
      closeSheet();
      onClick();
    });
    return b;
  }

  const ICONS = {
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7a2 2 0 0 1 2-2h4l2 2.4h6A2 2 0 0 1 20 9.4V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7a2 2 0 0 1 2-2h4l2 2.4h6A2 2 0 0 1 20 9.4V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.8c0-.8.9-1.3 1.6-.9l8.3 5.9c.6.4.6 1.3 0 1.7l-8.3 5.9c-.7.4-1.6-.1-1.6-.9V5.8z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5h6v2M7 7l1 12h8l1-12"/><path d="M10 11v4M14 11v4"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 7h11M4 12h11M4 17h7"/><circle cx="18" cy="15" r="2"/><path d="M20 15V7l-2 .8"/></svg>',
  };

  function openSheet() {
    $('sheetWrap').classList.add('open');
    syncScrollLock();
  }

  function closeSheet() {
    $('sheetWrap').classList.remove('open');
    syncScrollLock();
  }

  function importMenu() {
    const sheet = sheetBase('导入音乐');
    sheet.appendChild(sheetButton(ICONS.file, '从「文件」选择音乐', () => $('fileInput').click()));
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (!isIOS) sheet.appendChild(sheetButton(ICONS.folder, '选择整个文件夹', () => $('dirInput').click(), { sub: '桌面浏览器' }));

    const needFix = state.tracks.some((t) => (
      MusicTags.repairText(t.title) !== t.title
      || MusicTags.repairText(t.artist) !== t.artist
      || MusicTags.repairText(t.album) !== t.album
      || MusicTags.repairText(t.name) !== t.name
    ));
    if (needFix) {
      sheet.appendChild(sheetButton(ICONS.info, '修复所有乱码名称', repairAllNames, { sub: '批量' }));
    }

    sheet.appendChild(sheetButton(ICONS.info, '导入说明', showHelp));
    openSheet();
  }

  async function repairAllNames() {
    let n = 0;
    for (const t of state.tracks) {
      const nt = MusicTags.repairText(t.title);
      const na = MusicTags.repairText(t.artist);
      const nb = MusicTags.repairText(t.album);
      const nn = MusicTags.repairText(t.name);
      if (nt !== t.title || na !== t.artist || nb !== t.album || nn !== t.name) {
        t.title = nt;
        t.artist = na;
        t.album = nb;
        t.name = nn;
        try { await MusicDB.updateMeta(t); } catch (e) { /* ignore */ }
        n++;
      }
    }
    render();
    toast(n ? `已修复 ${n} 首` : '没有检测到乱码名称');
  }

  function showHelp() {
    const sheet = sheetBase('如何把音乐导入 iPhone');
    const hint = document.createElement('div');
    hint.className = 'sheetHint';
    hint.innerHTML =
      '1. 用「文件」App 或电脑把歌曲放进 iPhone（例如「我的 iPhone › 文件 › Music」）。<br>' +
      '2. 回到本应用，点 ＋ →「从文件选择音乐」。<br>' +
      '3. 进入音乐文件夹，点右上角「选择」→ 全选，或逐个勾选。<br>' +
      '4. 点「打开」开始导入；导入完成后歌曲保存在本机，断网也能播放。<br><br>' +
      '支持 MP3 / M4A / AAC / WAV / FLAC / OGG。导入后可在列表里点「…」删除。';
    sheet.appendChild(hint);
    sheet.appendChild(sheetButton(ICONS.info, '存储自检', async () => {
      toast('正在测试本地存储…');
      const r = await MusicDB.selfTest();
      toast(r.ok ? '存储写入正常（分片测试通过）' : `存储异常：${r.error || '未知错误'}`);
    }));
    const btn = document.createElement('button');
    btn.className = 'sheetCancel';
    btn.textContent = '知道了';
    btn.addEventListener('click', closeSheet);
    sheet.appendChild(btn);
    openSheet();
  }

  function trackMenu(t) {
    const sheet = sheetBase(t.title);
    sheet.appendChild(sheetButton(ICONS.play, '立即播放', () => {
      const ids = state.filtered.map((x) => x.id);
      state.queue = ids.includes(t.id) ? ids : [t.id, ...ids];
      state.qIndex = state.queue.indexOf(t.id);
      playTrack(t.id);
    }));

    const fixedTitle = MusicTags.repairText(t.title);
    const fixedArtist = MusicTags.repairText(t.artist);
    const fixedAlbum = MusicTags.repairText(t.album);
    const fixedName = MusicTags.repairText(t.name);
    if (fixedTitle !== t.title || fixedArtist !== t.artist || fixedAlbum !== t.album || fixedName !== t.name) {
      sheet.appendChild(sheetButton(ICONS.info, '修复乱码名称', async () => {
        t.title = fixedTitle;
        t.artist = fixedArtist;
        t.album = fixedAlbum;
        t.name = fixedName;
        try { await MusicDB.updateMeta(t); } catch (e) { /* ignore */ }
        render();
        toast('已修复乱码名称');
      }));
    }

    sheet.appendChild(sheetButton(ICONS.list, '加入播放队列末尾', () => {
      if (!state.queue.includes(t.id)) {
        state.queue.push(t.id);
        toast('已加入队列');
      } else toast('已经在队列中');
    }));
    sheet.appendChild(sheetButton(ICONS.trash, '从本机删除', () => confirmDelete(t), { danger: true }));
    sheet.appendChild(sheetButton(ICONS.info, '文件信息', () => showInfo(t)));
    openSheet();
  }

  function confirmDelete(t) {
    const sheet = sheetBase('删除音乐');
    const hint = document.createElement('div');
    hint.className = 'sheetHint';
    hint.textContent = `将从本机移除「${t.title}」及其封面，无法恢复。`;
    sheet.appendChild(hint);
    sheet.appendChild(sheetButton(ICONS.trash, '确认删除', () => deleteTrack(t), { danger: true }));
    const cancel = document.createElement('button');
    cancel.className = 'sheetCancel';
    cancel.textContent = '取消';
    cancel.addEventListener('click', closeSheet);
    sheet.appendChild(cancel);
    openSheet();
  }

  function showInfo(t) {
    const sheet = sheetBase('文件信息');
    const hint = document.createElement('div');
    hint.className = 'sheetHint';
    hint.innerHTML = [
      `文件名：${escapeHtml(t.name)}`,
      `标题：${escapeHtml(t.title)}`,
      `歌手：${escapeHtml(t.artist || '—')}`,
      `专辑：${escapeHtml(t.album || '—')}`,
      `时长：${t.duration ? fmtTime(t.duration) : '未知'}`,
      `大小：${fmtBytes(t.size)}`,
      `格式：${escapeHtml(t.mime || '音频')}`,
    ].join('<br>');
    sheet.appendChild(hint);
    const btn = document.createElement('button');
    btn.className = 'sheetCancel';
    btn.textContent = '关闭';
    btn.addEventListener('click', closeSheet);
    sheet.appendChild(btn);
    openSheet();
  }

  async function deleteTrack(t) {
    try {
      await MusicDB.remove(t);
    } catch (e) { /* ignore */ }
    state.tracks = state.tracks.filter((x) => x.id !== t.id);
    audioCache.delete(t.id);
    const cu = coverUrls.get(t.id);
    if (cu) { try { URL.revokeObjectURL(cu); } catch (e) { /* ignore */ } coverUrls.delete(t.id); }

    if (state.currentId === t.id) {
      audio.pause();
      audio.removeAttribute('src');
      try { audio.load(); } catch (e) { /* ignore */ }
      state.currentId = null;
      if (currentAudioUrl) { try { URL.revokeObjectURL(currentAudioUrl); } catch (e) { /* ignore */ } currentAudioUrl = null; }
      state.queue = state.queue.filter((x) => x !== t.id);
      state.qIndex = -1;
      updateNowUI();
    } else {
      const idx = state.queue.indexOf(t.id);
      if (idx >= 0 && idx < state.qIndex) state.qIndex -= 1;
      state.queue = state.queue.filter((x) => x !== t.id);
      if (state.qIndex >= state.queue.length) state.qIndex = state.queue.length - 1;
      if (state.qIndex < 0) state.qIndex = 0;
    }
    render();
    toast('已删除');
  }

  function queueSheet() {
    const sheet = sheetBase('播放队列');
    const wrap = document.createElement('div');
    wrap.className = 'queueList';
    if (!state.queue.length) {
      const hint = document.createElement('div');
      hint.className = 'sheetHint';
      hint.textContent = '队列是空的，先播放一首歌吧。';
      wrap.appendChild(hint);
    }
    state.queue.forEach((id, i) => {
      const t = byId(id);
      if (!t) return;
      const item = document.createElement('button');
      item.className = 'queueItem' + (id === state.currentId ? ' current' : '');
      item.innerHTML = `<span class="qIndex">${i + 1}</span><span style="min-width:0;flex:1"><span class="qTitle">${escapeHtml(t.title)}</span><span class="qArtist">${escapeHtml(t.artist || '未知歌手')}</span></span>`;
      item.addEventListener('click', () => {
        closeSheet();
        state.qIndex = i;
        playTrack(id);
      });
      wrap.appendChild(item);
    });
    sheet.appendChild(wrap);
    openSheet();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ------------------------------------------------------------ player */

  function openPlayer() {
    $('player').classList.add('open');
    $('player').setAttribute('aria-hidden', 'false');
    syncScrollLock();
  }

  function closePlayer() {
    $('player').classList.remove('open');
    $('player').setAttribute('aria-hidden', 'true');
    syncScrollLock();
  }

  function syncScrollLock() {
    const locked = $('player').classList.contains('open') || $('sheetWrap').classList.contains('open');
    document.body.style.overflow = locked ? 'hidden' : '';
  }

  /* -------------------------------------------------------------- init */

  async function init() {
    makeAppleIcon();
    bindEvents();
    setupMediaSession();
    updateRepeatUI();

    // 恢复偏好
    state.shuffle = localStorage.getItem('mm.shuffle') === '1';
    state.repeat = localStorage.getItem('mm.repeat') || 'off';
    state.sort = localStorage.getItem('mm.sort') || 'added';
    $('btnShuffle').classList.toggle('on', state.shuffle);
    updateRepeatUI();

    try {
      await MusicDB.open();
      state.tracks = await MusicDB.all();
    } catch (e) {
      toast('本地数据库不可用：' + (e.message || '未知错误'));
    }

    render();
    restoreLast();
    warmCache();
    registerSW();
    maybeShowInstallHint();
    bindAudio();
  }

  function restoreLast() {
    const lastId = localStorage.getItem('mm.last');
    const pos = parseFloat(localStorage.getItem('mm.pos') || '0');
    if (!lastId || !byId(lastId)) return;
    state.currentId = lastId;
    if (state.filtered.length) {
      state.queue = state.filtered.map((t) => t.id);
      state.qIndex = Math.max(0, state.queue.indexOf(lastId));
    }
    updateNowUI();
    pendingSeek = pos > 2 ? pos : 0;
    $('timeCur').textContent = fmtTime(pendingSeek);
  }

  async function warmCache() {
    for (const t of state.tracks) {
      if (state.importing) break;
      if (audioCache.has(t.id)) continue;
      try {
        const b = await MusicDB.getAudio(t);
        if (b) audioCache.set(t.id, b);
      } catch (e) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 6));
    }
  }

  function bindAudio() {
    audio.addEventListener('play', updatePlayState);
    audio.addEventListener('pause', updatePlayState);
    audio.addEventListener('timeupdate', updateProgress);
    audio.addEventListener('loadedmetadata', () => {
      const t = state.currentId ? byId(state.currentId) : null;
      if (t && isFinite(audio.duration) && audio.duration > 0 && (!t.duration || Math.abs(t.duration - audio.duration) > 1)) {
        t.duration = audio.duration;
        try { MusicDB.updateMeta(t); } catch (e) { /* ignore */ }
        updateRowDuration(t.id, t.duration);
      }
      if (pendingSeek > 0) {
        try { audio.currentTime = Math.min(pendingSeek, (audio.duration || pendingSeek) - 0.5); } catch (e) { /* ignore */ }
        pendingSeek = 0;
      }
      updateProgress();
    });
    audio.addEventListener('ended', () => next(true));
    audio.addEventListener('error', () => {
      if (audio.src) toast('这首音频无法播放，可能格式不受支持');
    });

    // iOS 首次交互解锁 audio 元素
    const unlock = () => {
      document.removeEventListener('pointerdown', unlock);
      try {
        if (!audio.src) {
          const sr = 8000;
          const len = 400;
          const buf = new ArrayBuffer(44 + len);
          const v = new DataView(buf);
          const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
          w(0, 'RIFF'); v.setUint32(4, 36 + len, true); w(8, 'WAVE'); w(12, 'fmt ');
          v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
          v.setUint32(24, sr, true); v.setUint32(28, sr, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
          w(36, 'data'); v.setUint32(40, len, true);
          for (let i = 0; i < len; i++) v.setUint8(44 + i, 128);
          const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
          const silentSrc = url;
          audio.src = silentSrc;
          audio.volume = 0;
          const cleanup = () => {
            if (audio.src === silentSrc) {
              audio.pause();
              audio.removeAttribute('src');
            }
            audio.volume = 1;
            try { URL.revokeObjectURL(silentSrc); } catch (e) { /* ignore */ }
          };
          const p = audio.play();
          if (p && p.then) p.then(cleanup).catch(cleanup);
        }
      } catch (e) { /* ignore */ }
    };
    document.addEventListener('pointerdown', unlock, { once: false });
  }

  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const set = (name, fn) => {
      try { navigator.mediaSession.setActionHandler(name, fn); } catch (e) { /* ignore */ }
    };
    set('play', () => { audio.play().catch(() => {}); });
    set('pause', () => audio.pause());
    set('previoustrack', prev);
    set('nexttrack', () => next(false));
    set('seekbackward', () => { audio.currentTime = Math.max(0, audio.currentTime - 10); });
    set('seekforward', () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10); });
    set('seekto', (d) => { if (d && typeof d.seekTime === 'number') audio.currentTime = d.seekTime; });
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  function maybeShowInstallHint() {
    const standalone = window.navigator.standalone === true;
    if (standalone) return;
    if (localStorage.getItem('mm.hint') === '1') return;
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (!isIOS) return;
    setTimeout(() => {
      toast('点 Safari 分享按钮 → 添加到主屏幕，可全屏离线使用');
      localStorage.setItem('mm.hint', '1');
    }, 4200);
  }

  /* ------------------------------------------------------------ events */

  function bindEvents() {
    $('btnAdd').addEventListener('click', importMenu);
    $('btnEmptyImport').addEventListener('click', () => $('fileInput').click());
    $('btnImportPlayer').addEventListener('click', importMenu);
    $('btnPlayAll').addEventListener('click', () => playAll(false));

    $('btnSearch').addEventListener('click', () => {
      const bar = $('searchBar');
      const open = bar.classList.toggle('open');
      if (open) setTimeout(() => $('searchInput').focus(), 120);
      else { $('searchInput').value = ''; state.query = ''; render(); }
    });
    $('btnClearSearch').addEventListener('click', () => {
      $('searchInput').value = '';
      state.query = '';
      render();
      $('searchInput').focus();
    });
    $('searchInput').addEventListener('input', (e) => {
      const v = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.query = v;
        render();
      }, 110);
    });

    $('sortChips').addEventListener('click', (e) => {
      const btn = e.target.closest('.chip[data-sort]');
      if (!btn) return;
      state.sort = btn.dataset.sort;
      localStorage.setItem('mm.sort', state.sort);
      render();
    });

    $('btnPlay').addEventListener('click', togglePlay);
    $('miniPlay').addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });
    $('miniNext').addEventListener('click', (e) => { e.stopPropagation(); next(false); });
    $('btnPrev').addEventListener('click', prev);
    $('btnNext').addEventListener('click', () => next(false));
    $('btnShuffle').addEventListener('click', toggleShuffle);
    $('btnRepeat').addEventListener('click', cycleRepeat);

    $('btnClosePlayer').addEventListener('click', closePlayer);
    $('btnTrackMenu').addEventListener('click', () => {
      const t = state.currentId ? byId(state.currentId) : null;
      if (t) trackMenu(t);
    });
    $('btnQueue').addEventListener('click', queueSheet);

    $('mini').addEventListener('click', () => {
      if (!state.currentId && state.filtered.length) playTrack(state.filtered[0].id);
      else openPlayer();
    });

    $('sheetWrap').addEventListener('click', (e) => {
      if (e.target === $('sheetWrap')) closeSheet();
    });

    $('fileInput').addEventListener('change', (e) => {
      const files = e.target.files;
      const arr = files ? Array.from(files) : [];
      e.target.value = '';
      if (arr.length) importFiles(arr);
    });
    $('btnCancelImport').addEventListener('click', () => {
      if (!state.importing) return;
      state.importCancel = true;
      $('importSub').textContent = '正在停止…';
    });
    $('dirInput').addEventListener('change', (e) => {
      const files = e.target.files;
      const arr = files ? Array.from(files) : [];
      e.target.value = '';
      if (arr.length) importFiles(arr);
    });

    bindSeek();

    document.addEventListener('keydown', (e) => {
      if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); next(false); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
      else if (e.key === 'Escape') { closeSheet(); closePlayer(); }
    });

    window.addEventListener('beforeunload', () => {
      saveSession();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveSession();
    });
    setInterval(saveSession, 5000);
  }

  function saveSession() {
    try {
      if (state.currentId) localStorage.setItem('mm.last', state.currentId);
      if (audio.currentTime) localStorage.setItem('mm.pos', String(audio.currentTime));
      localStorage.setItem('mm.shuffle', state.shuffle ? '1' : '0');
      localStorage.setItem('mm.repeat', state.repeat);
    } catch (e) { /* ignore */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
