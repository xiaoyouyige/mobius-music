/* =========================================================
   IndexedDB 存储（分片写入，适配 iOS Safari）

   tracks : 元数据（含 chunks 分片数）
   audio  : { id: "trackId#0", index, mime, blob } 每片 2MB
   covers : { id, blob } 原始封面

   大 Blob 一次性写入在 iOS 上可能永远不完成；
   这里按 2MB 分片、每片独立事务写入，失败重试，播放时拼回。
   ========================================================= */
(function () {
  'use strict';

  const DB_NAME = 'mobius-music';
  const DB_VERSION = 1;
  const STORES = ['tracks', 'audio', 'covers'];
  const CHUNK = 2 * 1024 * 1024;

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('当前浏览器不支持 IndexedDB'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      const timer = setTimeout(() => reject(new Error('数据库打开超时')), 8000);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('tracks')) {
          const s = db.createObjectStore('tracks', { keyPath: 'id' });
          s.createIndex('addedAt', 'addedAt');
        }
        if (!db.objectStoreNames.contains('audio')) {
          db.createObjectStore('audio', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('covers')) {
          db.createObjectStore('covers', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => { clearTimeout(timer); resolve(req.result); };
      req.onerror = () => { clearTimeout(timer); reject(req.error || new Error('无法打开数据库')); };
      req.onblocked = () => { clearTimeout(timer); reject(new Error('数据库被其他页面占用')); };
    });
    return dbPromise;
  }

  /** 关闭并丢弃连接：让卡住的事务被 abort，后续操作重新连接 */
  function reset() {
    const p = dbPromise;
    dbPromise = null;
    if (p) {
      p.then((db) => { try { db.close(); } catch (e) { /* ignore */ } }).catch(() => {});
    }
  }

  function openTx(stores, mode, fn, timeoutMs) {
    return open().then((db) => new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(stores, mode);
      } catch (e) {
        reject(e);
        return;
      }

      let settled = false;
      let timer = null;

      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (err) reject(err);
        else resolve(value === undefined ? true : value);
      };

      timer = setTimeout(() => {
        try { tx.abort(); } catch (e) { /* ignore */ }
        reset();
        finish(new Error('db-timeout'));
      }, timeoutMs || 20000);

      tx.oncomplete = () => finish(null);
      tx.onerror = () => finish(tx.error || new Error('db-error'));
      tx.onabort = () => finish(tx.error || new Error('db-abort'));

      try {
        fn(tx, stores.map((s) => tx.objectStore(s)));
      } catch (e) {
        try { tx.abort(); } catch (e2) { /* ignore */ }
        finish(e);
      }
    }));
  }

  function all() {
    return open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction('tracks', 'readonly');
      const req = tx.objectStore('tracks').getAll();
      const timer = setTimeout(() => {
        try { tx.abort(); } catch (e) { /* ignore */ }
        reject(new Error('读取超时'));
      }, 12000);
      req.onsuccess = () => { clearTimeout(timer); resolve(req.result || []); };
      req.onerror = () => { clearTimeout(timer); reject(req.error); };
    }));
  }

  function get(store, id) {
    return open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(id);
      const timer = setTimeout(() => {
        try { tx.abort(); } catch (e) { /* ignore */ }
        reject(new Error('读取超时'));
      }, 12000);
      req.onsuccess = () => { clearTimeout(timer); resolve(req.result ? req.result.blob : null); };
      req.onerror = () => { clearTimeout(timer); reject(req.error); };
    }));
  }

  /**
   * 读取音频：
   * - 新格式：track.chunks 个分片，逐个 get 后拼成 Blob
   * - 旧格式：单条 { id, blob }
   */
  function getAudio(track) {
    if (!track) return Promise.resolve(null);
    const id = typeof track === 'string' ? track : track.id;
    const count = (typeof track === 'object' && track.chunks) || 0;
    if (!count) return get('audio', id);

    return open().then((db) => new Promise((resolve) => {
      let tx;
      try {
        tx = db.transaction('audio', 'readonly');
      } catch (e) {
        resolve(null);
        return;
      }
      const store = tx.objectStore('audio');
      const parts = new Array(count);
      let remaining = count;
      let mime = 'audio/mpeg';
      let settled = false;

      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        try { tx.abort(); } catch (e) { /* ignore */ }
        done(null);
      }, 15000);

      for (let i = 0; i < count; i++) {
        const req = store.get(`${id}#${i}`);
        req.onsuccess = () => {
          const rec = req.result;
          if (rec) {
            parts[rec.index] = rec.blob;
            if (rec.mime) mime = rec.mime;
          }
          remaining -= 1;
          if (remaining === 0) {
            const blobs = parts.filter(Boolean);
            done(blobs.length ? new Blob(blobs, { type: mime }) : null);
          }
        };
        req.onerror = () => {
          remaining -= 1;
          if (remaining === 0) done(null);
        };
      }
    })).catch(() => null);
  }

  function getCover(id) { return get('covers', id); }

  async function putChunks(track, blob) {
    const size = blob.size;
    const total = Math.max(1, Math.ceil(size / CHUNK));
    track.chunks = total;

    for (let i = 0; i < total; i++) {
      const part = blob.slice(i * CHUNK, Math.min(size, (i + 1) * CHUNK));
      const rec = {
        id: `${track.id}#${i}`,
        index: i,
        mime: blob.type || track.mime || 'audio/mpeg',
        blob: part,
      };
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await openTx(['audio'], 'readwrite', (tx, s) => { s[0].put(rec); }, 8000);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          const text = String((e && (e.name + ' ' + e.message)) || '');
          if (/quota|storage|exceed/i.test(text)) throw e;
        }
      }
      if (lastErr) throw lastErr;
    }

    await openTx(['tracks'], 'readwrite', (tx, s) => { s[0].put(track); }, 12000);
  }

  async function put(track, audioBlob, coverBlob) {
    try {
      await putChunks(track, audioBlob);
    } catch (e) {
      try { await remove(track); } catch (e2) { /* ignore */ }
      throw e;
    }

    if (coverBlob) {
      try {
        await openTx(['covers'], 'readwrite', (tx, s) => {
          s[0].put({ id: track.id, blob: coverBlob });
        }, 6000);
      } catch (e) { /* 封面失败可接受 */ }
    }
    return true;
  }

  function updateMeta(track) {
    return openTx(['tracks'], 'readwrite', (tx, s) => {
      s[0].put(track);
    }, 12000);
  }

  function remove(track) {
    const id = typeof track === 'string' ? track : track.id;
    const count = (typeof track === 'object' && track.chunks) || 0;
    return openTx(STORES, 'readwrite', (tx, s) => {
      s[0].delete(id);
      s[2].delete(id);
      s[1].delete(id);
      for (let i = 0; i < count; i++) s[1].delete(`${id}#${i}`);
    }, 15000);
  }

  function clear() {
    return openTx(STORES, 'readwrite', (tx, s) => {
      s.forEach((store) => store.clear());
    }, 20000);
  }

  async function estimate() {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        return { usage: e.usage || 0, quota: e.quota || 0 };
      }
    } catch (e) { /* ignore */ }
    return { usage: 0, quota: 0 };
  }

  /** 存储自检：写入一个完整分片（2MB）、读回、删除 */
  async function selfTest() {
    const payload = new Uint8Array(CHUNK);
    for (let i = 0; i < payload.length; i += 4096) payload[i] = i & 0xff;

    const track = {
      id: '__selftest__',
      fp: 'selftest',
      name: 'selftest.bin',
      title: 'selftest',
      artist: '',
      album: '',
      duration: 0,
      size: payload.length,
      mime: 'application/octet-stream',
      addedAt: Date.now(),
      thumb: null,
      hasCover: false,
    };
    const blob = new Blob([payload], { type: 'application/octet-stream' });
    try {
      await put(track, blob, null);
      const got = await getAudio(track);
      await remove(track).catch(() => {});
      const ok = !!(got && got.size === payload.length);
      return { ok, error: ok ? null : '读回数据不完整' };
    } catch (e) {
      try { await remove(track); } catch (e2) { /* ignore */ }
      return { ok: false, error: String((e && (e.name + ': ' + e.message)) || e) };
    }
  }

  function destroy() {
    reset();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve(true);
      };
      try {
        const req = indexedDB.deleteDatabase(DB_NAME);
        req.onsuccess = finish;
        req.onerror = finish;
        req.onblocked = finish;
      } catch (e) {
        finish();
      }
      setTimeout(finish, 3000);
    });
  }

  window.MusicDB = {
    open, all, getAudio, getCover, put, updateMeta, remove, clear, estimate, reset, destroy, selfTest,
  };
})();
