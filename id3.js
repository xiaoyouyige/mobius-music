/* =========================================================
   轻量标签解析：ID3v2 (MP3) / iTunes atoms (M4A)
   失败时自动回退到文件名
   ========================================================= */
(function () {
  'use strict';

  const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|wav|flac|ogg|oga|opus|aiff?|wma)$/i;

  function isAudioFile(file) {
    if (!file) return false;
    if (file.type && file.type.indexOf('audio/') === 0) return true;
    return AUDIO_EXT.test(file.name || '');
  }

  /**
   * 修复中文标签常见的乱码：GBK 字节被当成 ISO-8859-1 解码。
   * 例如 "夜航星" 的 GBK 字节被解成 "Ò¹º½ÐÇ"，这里按字节还原后重新解码。
   */
  const CP1252 = {
    0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
    0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
    0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
    0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
    0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
    0x017e: 0x9e, 0x0178: 0x9f,
  };

  function repairText(input) {
    if (!input || typeof input !== 'string') return input;
    if (!/[\u0080-\u00ff\u2018-\u201e\u2020-\u2022\u2026\u2030\u2039\u203a\u20ac\u2122\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc]/.test(input)) return input;
    if (/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(input)) return input;

    const bytes = [];
    let high = 0;
    for (const ch of input) {
      const c = ch.codePointAt(0);
      let b;
      if (c <= 0xff) b = c;
      else if (CP1252[c] !== undefined) b = CP1252[c];
      else return input;
      if (b >= 0x80) high++;
      bytes.push(b);
    }
    if (high < 4) return input;

    for (const enc of ['gbk', 'big5']) {
      try {
        const out = new TextDecoder(enc, { fatal: false }).decode(new Uint8Array(bytes));
        const cjk = (out.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]/g) || []).length;
        const bad = (out.match(/\ufffd/g) || []).length;
        if (cjk >= 2 && bad === 0) return out;
      } catch (e) { /* ignore */ }
    }
    return input;
  }

  function str4(bytes, p) {
    return String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
  }

  function uint32(bytes, p) {
    return ((bytes[p] << 24) >>> 0) + (bytes[p + 1] << 16) + (bytes[p + 2] << 8) + bytes[p + 3];
  }

  function syncsafe(bytes, p) {
    return ((bytes[p] & 0x7f) << 21) | ((bytes[p + 1] & 0x7f) << 14) | ((bytes[p + 2] & 0x7f) << 7) | (bytes[p + 3] & 0x7f);
  }

  function decLatin1(bytes, start, end) {
    let s = '';
    for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function decUtf8(bytes, start, end) {
    try {
      return new TextDecoder('utf-8').decode(bytes.subarray(start, end));
    } catch (e) {
      return decLatin1(bytes, start, end);
    }
  }

  function decUtf16(bytes, start, end) {
    let little = true;
    let s = start;
    if (end - start >= 2) {
      if (bytes[start] === 0xff && bytes[start + 1] === 0xfe) { little = true; s += 2; }
      else if (bytes[start] === 0xfe && bytes[start + 1] === 0xff) { little = false; s += 2; }
    }
    const body = bytes.subarray(s, end);
    try {
      return new TextDecoder(little ? 'utf-16le' : 'utf-16be').decode(body);
    } catch (e) {
      let out = '';
      for (let i = 0; i + 1 < body.length; i += 2) {
        const code = little ? body[i] | (body[i + 1] << 8) : (body[i] << 8) | body[i + 1];
        if (code) out += String.fromCharCode(code);
      }
      return out;
    }
  }

  function decodeText(bytes, enc, start, end) {
    let s = '';
    if (enc === 0) s = decLatin1(bytes, start, end);
    else if (enc === 1) s = decUtf16(bytes, start, end);
    else if (enc === 2) {
      // UTF-16BE without BOM
      let swapped = new Uint8Array(Math.max(0, end - start));
      for (let i = 0; i + 1 < swapped.length; i += 2) {
        swapped[i] = bytes[start + i + 1];
        swapped[i + 1] = bytes[start + i];
      }
      s = decUtf16(swapped, 0, swapped.length);
    } else s = decUtf8(bytes, start, end);
    return repairText(s.replace(/\u0000+$/g, '').trim());
  }

  function parseID3(bytes, fallback) {
    const out = { title: '', artist: '', album: '', cover: null };
    const ver = bytes[3];
    const flags = bytes[5];
    const size = syncsafe(bytes, 6);
    let p = 10;

    if (flags & 0x40) {
      // 扩展头
      const ext = ver >= 4 ? syncsafe(bytes, p) : uint32(bytes, p);
      p += ver >= 4 ? ext : ext + 4;
    }

    const end = Math.min(bytes.length, 10 + size);
    let guard = 0;
    while (p + 10 <= end && guard++ < 400) {
      const id = str4(bytes, p);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const frameSize = ver >= 4 ? syncsafe(bytes, p + 4) : uint32(bytes, p + 4);
      if (!frameSize || frameSize > end - p - 10) break;
      const dataStart = p + 10;
      const dataEnd = dataStart + frameSize;
      const enc = bytes[dataStart];

      try {
        if (id === 'TIT2') out.title = decodeText(bytes, enc, dataStart + 1, dataEnd);
        else if (id === 'TPE1') out.artist = decodeText(bytes, enc, dataStart + 1, dataEnd);
        else if (id === 'TALB') out.album = decodeText(bytes, enc, dataStart + 1, dataEnd);
        else if (id === 'TLEN') {
          const ms = parseInt(decodeText(bytes, enc, dataStart + 1, dataEnd), 10);
          if (isFinite(ms) && ms > 0) out.duration = ms / 1000;
        } else if (id === 'APIC') {
          let q = dataStart + 1;
          let mime = '';
          while (q < dataEnd && bytes[q] !== 0) { mime += String.fromCharCode(bytes[q]); q++; }
          q++; // mime 结束符
          q++; // 图片类型
          if (enc === 0 || enc === 3) {
            while (q < dataEnd && bytes[q] !== 0) q++;
            q++;
          } else {
            while (q + 1 < dataEnd && !(bytes[q] === 0 && bytes[q + 1] === 0)) q += 2;
            q += 2;
          }
          if (q < dataEnd) {
            out.cover = new Blob([bytes.subarray(q, dataEnd)], { type: mime || 'image/jpeg' });
          }
        }
      } catch (e) { /* 单帧失败忽略 */ }

      p = dataEnd;
    }

    return Object.assign({}, fallback, trimFields(out));
  }

  function trimFields(o) {
    const r = {};
    if (o.title) r.title = o.title;
    if (o.artist) r.artist = o.artist;
    if (o.album) r.album = o.album;
    if (o.cover) r.cover = o.cover;
    if (o.duration && isFinite(o.duration) && o.duration > 0) r.duration = o.duration;
    return r;
  }

  function viewOf(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  function findAtom(view, start, end, target, depth) {
    depth = depth || 0;
    if (depth > 9) return null;
    let p = start;
    let guard = 0;
    while (p + 8 <= end && guard++ < 2000) {
      let size = view.getUint32(p);
      const type = String.fromCharCode(view.getUint8(p + 4), view.getUint8(p + 5), view.getUint8(p + 6), view.getUint8(p + 7));
      let header = 8;
      if (size === 1) {
        if (p + 16 > end) break;
        size = Number(view.getBigUint64(p + 8));
        header = 16;
      } else if (size === 0) {
        size = end - p;
      }
      if (size < header || p + size > end) break;

      if (type === target) return { start: p + header, end: p + size };

      const childStart = type === 'meta' ? p + header + 4 : p + header;
      if (childStart < p + size) {
        const inner = findAtom(view, childStart, p + size, target, depth + 1);
        if (inner) return inner;
      }
      p += size;
    }
    return null;
  }

  function findMoovBySignature(bytes) {
    const view = viewOf(bytes);
    for (let i = bytes.length - 8; i >= 4; i--) {
      if (bytes[i] === 0x6d && bytes[i + 1] === 0x6f && bytes[i + 2] === 0x6f && bytes[i + 3] === 0x76) {
        const start = i - 4;
        const size = view.getUint32(start);
        if (size > 8 && start + size <= bytes.length && start + size > i + 4) {
          return { start: i + 4, end: start + size };
        }
      }
    }
    return null;
  }

  function parseMp4Buffer(bytes, allowScan) {
    const out = { title: '', artist: '', album: '', cover: null, duration: 0 };
    const view = viewOf(bytes);
    let moov = findAtom(view, 0, bytes.length, 'moov', 0);
    if (!moov && allowScan) moov = findMoovBySignature(bytes);
    if (!moov) return out;

    // mvhd 里的时长/时间刻度，避免之后再探测音频
    try {
      const mvhd = findAtom(view, moov.start, moov.end, 'mvhd', 0);
      if (mvhd) {
        const version = bytes[mvhd.start];
        const tsOff = mvhd.start + (version === 1 ? 20 : 12);
        const durOff = mvhd.start + (version === 1 ? 24 : 16);
        const timescale = view.getUint32(tsOff);
        const dur = version === 1 ? Number(view.getBigUint64(durOff)) : view.getUint32(durOff);
        if (timescale > 0 && dur > 0) out.duration = dur / timescale;
      }
    } catch (e) { /* ignore */ }

    const ilst = findAtom(view, moov.start, moov.end, 'ilst', 0);
    if (!ilst) return out;

    const COPY = String.fromCharCode(0xa9);
    const map = { [COPY + 'nam']: 'title', [COPY + 'ART']: 'artist', [COPY + 'alb']: 'album' };

    let p = ilst.start;
    let guard = 0;
    while (p + 8 <= ilst.end && guard++ < 200) {
      const size = view.getUint32(p);
      const type = String.fromCharCode(view.getUint8(p + 4), view.getUint8(p + 5), view.getUint8(p + 6), view.getUint8(p + 7));
      if (size < 16 || p + size > ilst.end) break;

      const dStart = p + 8;
      const dSize = view.getUint32(dStart);
      const dType = String.fromCharCode(view.getUint8(dStart + 4), view.getUint8(dStart + 5), view.getUint8(dStart + 6), view.getUint8(dStart + 7));

      if (dType === 'data' && dSize >= 16) {
        const kind = view.getUint32(dStart + 8);
        const dataStart = dStart + 16;
        const dataEnd = Math.min(dStart + dSize, ilst.end);
        if (map[type]) {
          out[map[type]] = decUtf8(bytes, dataStart, dataEnd).trim();
        } else if (type === 'covr' && dataEnd > dataStart) {
          const mime = kind === 14 ? 'image/png' : 'image/jpeg';
          out.cover = new Blob([bytes.subarray(dataStart, dataEnd)], { type: mime });
        }
      }
      p += size;
    }
    return out;
  }

  function parseWav(bytes) {
    const out = { duration: 0 };
    if (bytes.length < 44) return out;
    const view = viewOf(bytes);
    let p = 12;
    let byteRate = 0;
    let dataSize = 0;
    let guard = 0;
    while (p + 8 <= bytes.length && guard++ < 200) {
      const id = str4(bytes, p);
      const size = view.getUint32(p + 4, true);
      const data = p + 8;
      if (id === 'fmt ' && data + 16 <= bytes.length) {
        byteRate = view.getUint32(data + 8, true);
      } else if (id === 'data') {
        dataSize = size || (bytes.length - data);
        break;
      }
      p = data + size + (size % 2);
    }
    if (byteRate > 0 && dataSize > 0) out.duration = dataSize / byteRate;
    return out;
  }

  function parseFlac(bytes) {
    const out = { duration: 0 };
    if (bytes.length < 42) return out;
    if (!(bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43)) return out;
    const header = bytes[4];
    const type = header & 0x7f;
    const len = (bytes[5] << 16) | (bytes[6] << 8) | bytes[7];
    if (type !== 0 || len < 34 || 8 + 34 > bytes.length) return out;
    const b = bytes.subarray(18, 26); // STREAMINFO 内偏移 10..17
    const sampleRate = (b[0] << 12) | (b[1] << 4) | (b[2] >> 4);
    const total = (b[2] & 0x0f) * 4294967296 + b[3] * 16777216 + b[4] * 65536 + b[5] * 256 + b[6];
    if (sampleRate > 0 && total > 0) out.duration = total / sampleRate;
    return out;
  }

  async function parseTags(file) {
    const fallback = fromFilename(file.name || '未命名');
    try {
      if (!file.size) return fallback;

      // MP3 / ID3v2
      const headLen = Math.min(file.size, 512 * 1024);
      const head = new Uint8Array(await file.slice(0, headLen).arrayBuffer());

      if (head.length >= 12 && str4(head, 0) === 'RIFF' && str4(head, 8) === 'WAVE') {
        return Object.assign({}, fallback, trimFields(parseWav(head)));
      }
      if (head.length >= 4 && head[0] === 0x66 && head[1] === 0x4c && head[2] === 0x61 && head[3] === 0x43) {
        return Object.assign({}, fallback, trimFields(parseFlac(head)));
      }
      if (head.length >= 10 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
        return parseID3(head, fallback);
      }

      // M4A / MP4：在两端的 2MB 中寻找 moov
      if (head.length >= 12 && str4(head, 4) === 'ftyp') {
        const chunk = 2 * 1024 * 1024;
        let tags = parseMp4Buffer(head);
        if (!tags.title && file.size > chunk) {
          try {
            const tail = new Uint8Array(await file.slice(Math.max(0, file.size - chunk)).arrayBuffer());
            tags = parseMp4Buffer(tail, true);
          } catch (e) { /* ignore */ }
        }
        return Object.assign({}, fallback, trimFields(tags));
      }
    } catch (e) { /* 任何解析失败都回退 */ }
    return fallback;
  }

  function fromFilename(name) {
    let base = repairText(String(name)).replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
    let artist = '';
    let title = base;
    const m = base.match(/^(.{1,80}?)\s+[-–—]\s+(.+)$/);
    if (m) {
      artist = m[1].trim();
      title = m[2].trim();
    }
    title = title.replace(/^\s*\d{1,3}\s*[.\-、)）]\s*/, '').trim() || base;
    return { title, artist, album: '' };
  }

  async function makeThumb(blob, size) {
    if (!blob) return null;
    const s = size || 96;
    try {
      if ('createImageBitmap' in window) {
        let bmp;
        try {
          bmp = await createImageBitmap(blob, { resizeWidth: 192, resizeHeight: 192, resizeQuality: 'low' });
        } catch (e) {
          bmp = await createImageBitmap(blob);
        }
        const c = document.createElement('canvas');
        c.width = c.height = s;
        const g = c.getContext('2d');
        const side = Math.min(bmp.width, bmp.height);
        g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, s, s);
        if (bmp.close) bmp.close();
        return c.toDataURL('image/jpeg', 0.82);
      }
      const url = URL.createObjectURL(blob);
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = reject;
        im.src = url;
      });
      const c = document.createElement('canvas');
      c.width = c.height = s;
      const g = c.getContext('2d');
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, s, s);
      URL.revokeObjectURL(url);
      return c.toDataURL('image/jpeg', 0.82);
    } catch (e) {
      return null;
    }
  }

  window.MusicTags = { parseTags, fromFilename, makeThumb, isAudioFile, repairText };
})();
