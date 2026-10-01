"use strict";

// 酷狗 KRC：base64 → 去掉 krc1 → 16 字节循环 XOR → zlib。
// 翻译和罗马音在解密文本的 [language:] 标签里，不需要第二次请求。

var KRC_KEY = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105];

function b64ToBytes(input) {
  var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var clean = String(input || "").replace(/[^A-Za-z0-9+/=]/g, "");
  var out = [];
  var buffer = 0;
  var bits = 0;
  for (var i = 0; i < clean.length; i++) {
    var ch = clean.charAt(i);
    if (ch === "=") break;
    var value = alphabet.indexOf(ch);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 255);
    }
  }
  return out;
}

function xorKrc(bytes) {
  var out = [];
  for (var i = 4; i < bytes.length; i++) out.push(bytes[i] ^ KRC_KEY[(i - 4) % 16]);
  return out;
}

function bytesToUtf8(bytes) {
  var out = "";
  for (var i = 0; i < bytes.length;) {
    var b = bytes[i++];
    if (b < 128) {
      out += String.fromCharCode(b);
    } else if (b < 224) {
      var b2 = bytes[i++] || 0;
      out += String.fromCharCode(((b & 31) << 6) | (b2 & 63));
    } else if (b < 240) {
      var c2 = bytes[i++] || 0;
      var c3 = bytes[i++] || 0;
      out += String.fromCharCode(((b & 15) << 12) | ((c2 & 63) << 6) | (c3 & 63));
    } else {
      var d2 = bytes[i++] || 0;
      var d3 = bytes[i++] || 0;
      var d4 = bytes[i++] || 0;
      var cp = ((b & 7) << 18) | ((d2 & 63) << 12) | ((d3 & 63) << 6) | (d4 & 63);
      cp -= 65536;
      out += String.fromCharCode(55296 + (cp >> 10), 56320 + (cp & 1023));
    }
  }
  return out.replace(/^\uFEFF/, "");
}

// RFC 1951 inflate. 输入是去掉 zlib 头之后的 deflate 流，或完整 zlib。
function inflateZlib(bytes) {
  if (!bytes || bytes.length < 2) throw new Error("zlib 过短");
  var start = 2;
  if (bytes[0] !== 120) start = 0;
  var bitBuf = 0;
  var bitCount = 0;
  var pos = start;
  function need(n) {
    while (bitCount < n) {
      if (pos >= bytes.length) throw new Error("deflate 截断");
      bitBuf |= bytes[pos++] << bitCount;
      bitCount += 8;
    }
  }
  function take(n) {
    need(n);
    var value = bitBuf & ((1 << n) - 1);
    bitBuf >>= n;
    bitCount -= n;
    return value;
  }
  var lenBase = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var lenExtra = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  var distBase = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  var distExtra = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  var out = [];
  var final = 0;
  while (!final) {
    final = take(1);
    var type = take(2);
    if (type === 0) {
      bitBuf = 0;
      bitCount = 0;
      if (pos + 4 > bytes.length) throw new Error("stored 块截断");
      var len = bytes[pos] | (bytes[pos + 1] << 8);
      pos += 4;
      if (pos + len > bytes.length) throw new Error("stored 数据截断");
      for (var s = 0; s < len; s++) out.push(bytes[pos++]);
      continue;
    }
    if (type !== 1 && type !== 2) throw new Error("不支持的 deflate 类型");
    var litLen = [];
    var dist = [];
    if (type === 1) {
      for (var a = 0; a <= 143; a++) litLen.push(8);
      for (var b = 144; b <= 255; b++) litLen.push(9);
      for (var c = 256; c <= 279; c++) litLen.push(7);
      for (var d = 280; d <= 287; d++) litLen.push(8);
      for (var e = 0; e < 32; e++) dist.push(5);
    } else {
      var hlit = take(5) + 257;
      var hdist = take(5) + 1;
      var hclen = take(4) + 4;
      var order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
      var clen = [];
      for (var ci = 0; ci < 19; ci++) clen.push(0);
      for (var hi = 0; hi < hclen; hi++) clen[order[hi]] = take(3);
      var clTree = buildTree(clen);
      var lengths = [];
      while (lengths.length < hlit + hdist) {
        var sym = decodeSymbol(clTree);
        if (sym < 16) {
          lengths.push(sym);
        } else if (sym === 16) {
          var rep = take(2) + 3;
          var prev = lengths[lengths.length - 1];
          for (var r = 0; r < rep; r++) lengths.push(prev);
        } else if (sym === 17) {
          var z = take(3) + 3;
          for (var z1 = 0; z1 < z; z1++) lengths.push(0);
        } else {
          var z2 = take(7) + 11;
          for (var z3 = 0; z3 < z2; z3++) lengths.push(0);
        }
      }
      litLen = lengths.slice(0, hlit);
      dist = lengths.slice(hlit);
    }
    var litTree = buildTree(litLen);
    var distTree = buildTree(dist);
    while (true) {
      var code = decodeSymbol(litTree);
      if (code < 256) {
        out.push(code);
      } else if (code === 256) {
        break;
      } else {
        var length = lenBase[code - 257] + take(lenExtra[code - 257]);
        var distCode = decodeSymbol(distTree);
        var distance = distBase[distCode] + take(distExtra[distCode]);
        for (var n = 0; n < length; n++) out.push(out[out.length - distance]);
      }
    }
  }
  function buildTree(lengths) {
    var counts = [];
    var max = 0;
    for (var i = 0; i < lengths.length; i++) {
      var len = lengths[i];
      if (!len) continue;
      counts[len] = (counts[len] || 0) + 1;
      if (len > max) max = len;
    }
    var next = [];
    var code = 0;
    counts[0] = 0;
    for (var bits = 1; bits <= max; bits++) {
      code = (code + (counts[bits - 1] || 0)) << 1;
      next[bits] = code;
    }
    var tree = {};
    for (var sym = 0; sym < lengths.length; sym++) {
      var length = lengths[sym];
      if (!length) continue;
      var encoded = next[length]++;
      var node = tree;
      for (var bit = length - 1; bit >= 0; bit--) {
        var branch = (encoded >> bit) & 1;
        if (bit === 0) node[branch] = sym;
        else {
          if (typeof node[branch] !== "object") node[branch] = {};
          node = node[branch];
        }
      }
    }
    return tree;
  }
  function decodeSymbol(tree) {
    var node = tree;
    while (typeof node === "object") node = node[take(1)];
    if (typeof node !== "number") throw new Error("deflate 码表错误");
    return node;
  }
  return out;
}

function pad(n) {
  return n < 10 ? "0" + n : String(n);
}

function lrcTime(ms) {
  if (ms < 0) ms = 0;
  var total = Math.floor(ms / 10);
  var cs = total % 100;
  var sec = Math.floor(total / 100);
  var s = sec % 60;
  var m = Math.floor(sec / 60);
  return "[" + pad(m) + ":" + pad(s) + "." + pad(cs) + "]";
}

function parseLanguage(text) {
  var match = text.match(/\[language:([^\]]+)\]/);
  if (!match) return { translation: [], romanization: [] };
  var jsonText = bytesToUtf8(b64ToBytes(match[1]));
  var parsed;
  try { parsed = JSON.parse(jsonText); } catch (_) { return { translation: [], romanization: [] }; }
  var translation = [];
  var romanization = [];
  ((parsed && parsed.content) || []).forEach(function (block) {
    var rows = block.lyricContent || [];
    if (Number(block.type) === 1) {
      rows.forEach(function (row) { translation.push(row && row[0] ? String(row[0]) : ""); });
    } else if (Number(block.type) === 0) {
      rows.forEach(function (row) {
        romanization.push((row || []).join(""));
      });
    }
  });
  return { translation: translation, romanization: romanization };
}

function krcToLrc(text) {
  var lines = String(text || "").split(/\r?\n/);
  var timed = [];
  lines.forEach(function (line) {
    var match = line.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!match) return;
    var words = match[3].replace(/<\d+,\d+,\d+>/g, "");
    if (!words.trim()) return;
    timed.push({ start: Number(match[1]), text: words });
  });
  var language = parseLanguage(text);
  var original = timed.map(function (row) { return lrcTime(row.start) + row.text; }).join("\n");
  var translation = [];
  var romanization = [];
  var tIndex = 0;
  var rIndex = 0;
  timed.forEach(function (row) {
    if (tIndex < language.translation.length) {
      var translated = language.translation[tIndex++] || "";
      if (translated) translation.push(lrcTime(row.start) + translated);
    }
    if (rIndex < language.romanization.length) {
      var roman = language.romanization[rIndex++] || "";
      if (roman) romanization.push(lrcTime(row.start) + roman);
    }
  });
  return {
    original: original,
    translation: translation.join("\n"),
    romanization: romanization.join("\n")
  };
}

function decodeContent(content, fmt, contentType) {
  var bytes = b64ToBytes(content);
  var type = Number(contentType || 0);
  var format = String(fmt || "").toLowerCase();
  if (type === 2 || format === "lrc" || (bytes.length >= 1 && bytes[0] === 91)) {
    return bytesToUtf8(bytes);
  }
  if (bytes.length < 4) return "";
  return bytesToUtf8(inflateZlib(xorKrc(bytes)));
}

function assetsFromDownload(download) {
  var body = download || {};
  var content = String(body.content || "");
  if (!content) return [];
  var text = decodeContent(content, body.fmt, body.contenttype);
  if (!text) return [];
  if (/\[\d+,\d+\]/.test(text)) {
    var parsed = krcToLrc(text);
    var assets = [];
    if (parsed.original) assets.push({ format: "lrc", role: "original", text: parsed.original });
    if (parsed.translation) assets.push({ format: "lrc", role: "translation", text: parsed.translation });
    if (parsed.romanization) assets.push({ format: "lrc", role: "romanization", text: parsed.romanization });
    return assets;
  }
  if (text.indexOf("[") >= 0) return [{ format: "lrc", role: "original", text: text }];
  return [];
}

module.exports = {
  assetsFromDownload: assetsFromDownload,
  decodeContent: decodeContent,
  inflateZlib: inflateZlib
};
