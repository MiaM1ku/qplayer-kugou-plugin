"use strict";

// 酷狗音乐源插件。接口、签名与登录参考 go-music-dl / music-lib 的 kugou 实现。

var UA_MOBILE = "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1";
var UA_PC = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
var SIGN_KEY = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt";
var LITE_SIGN = "LnT6xpN3khm36zse0QzvmgTZ3waWdRSA";
var LITE_APPID = "3116";
var LITE_VER = "11440";
var REF_MOBILE = "http://m.kugou.com";
var RSA_N = "c40a2d0da76511f3bb1cc2bbd3afbd8bea83b4d6b05b6c13eb8920c53f1af7679b32ba0d0edb843240ef1b836efed3ee240734c14c1399fd6594d16af22f52525d14d72e0155c6dcc8638d4f7bb94f3a0b1f4c29f991972f2a160a25eb0a9e724336be7f69bbd319ffab1c6dd8470b021dc434f3faba89f4a2a01b33bdbdd08b";
var RSA_E = "010001";
var krc = require("./krc.js");
var gateway = require("./gateway");

function call(method, args) { return qplayer.call(method, args || {}); }

function secureUrl(value) {
  value = String(value || "").trim().replace("{size}", "400");
  if (!value) return "";
  if (value.indexOf("//") === 0) return "https:" + value;
  if (value.indexOf("http://") === 0) return "https://" + value.slice(7);
  return value;
}

function thumbUrl(value) {
  return secureUrl(String(value || "").replace("{size}", "150"));
}

function str(value) {
  if (value == null) return "";
  if (typeof value === "number") return String(Math.floor(value));
  return String(value).replace(/<[^>]*>/g, "").trim();
}

function num(value) {
  if (typeof value === "number") return Math.floor(value);
  var n = parseInt(String(value || "").trim(), 10);
  return isNaN(n) ? 0 : n;
}

function first() {
  for (var i = 0; i < arguments.length; i++) {
    var value = str(arguments[i]);
    if (value) return value;
  }
  return "";
}

function validHash(h) {
  h = String(h || "").toLowerCase();
  return /^[a-f0-9]{32}$/.test(h) && h !== "00000000000000000000000000000000";
}

function cookieHeader(cookies) {
  var parts = [];
  Object.keys(cookies || {}).forEach(function (name) {
    if (cookies[name]) parts.push(name + "=" + cookies[name]);
  });
  return parts.join("; ");
}

function loadCookies() {
  return call("credentials.get", { key: "cookies" }).then(function (stored) {
    if (!stored) return {};
    try { return JSON.parse(stored); } catch (_) { return {}; }
  }, function () { return {}; });
}

function headers(ua, extra) {
  return loadCookies().then(function (cookies) {
    var all = { "User-Agent": ua || UA_MOBILE, "Referer": REF_MOBILE };
    var cookie = cookieHeader(cookies);
    if (cookie) all.Cookie = cookie;
    if (extra) Object.keys(extra).forEach(function (key) { all[key] = extra[key]; });
    return all;
  });
}

function httpGet(url, ua, extra) {
  return headers(ua, extra).then(function (all) {
    return call("http.request", { url: url, method: "GET", headers: all, timeoutMs: 15000 });
  }).then(function (response) {
    if (response.status < 200 || response.status >= 300) throw new Error("HTTP " + response.status);
    return String(response.body || "");
  });
}

function httpGetJson(url, ua, extra) {
  return httpGet(url, ua, extra).then(function (body) { return JSON.parse(body || "{}"); });
}

function md5Hex(data) {
  return call("crypto.digest", { algorithm: "MD5", data: data, dataEncoding: "utf8", outputEncoding: "hex" });
}

function signParams(params, key) {
  var pairs = Object.keys(params).map(function (k) { return k + "=" + params[k]; }).sort();
  return md5Hex(key + pairs.join("") + key);
}

function queryOf(params) {
  return Object.keys(params).map(function (key) {
    return encodeURIComponent(key) + "=" + encodeURIComponent(params[key]);
  }).join("&");
}

function cleanName(value) {
  return str(value).replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

function splitArtistTitle(filename, fallbackArtist, fallbackTitle) {
  var artist = cleanName(fallbackArtist);
  var title = cleanName(fallbackTitle);
  if ((!title || !artist) && filename) {
    var parts = String(filename).split(" - ");
    if (parts.length >= 2) {
      artist = artist || parts[0].trim();
      title = title || parts.slice(1).join(" - ").trim();
    } else if (!title) title = String(filename).trim();
  }
  return { artist: artist, title: title };
}

function artistsOf(name) {
  name = cleanName(name);
  if (!name) return [];
  return name.split(/[、,&\/]/).map(function (part) {
    part = part.trim();
    return part ? { id: part, name: part } : null;
  }).filter(Boolean);
}

function artistsFromItem(item, fallbackName) {
  var out = [];
  var list = item.Singers || item.singers || item.authors || [];
  (list || []).forEach(function (singer) {
    var name = cleanName(singer.SingerName || singer.name || singer.singername);
    var id = str(singer.SingerId || singer.singerid || singer.id);
    if (name) out.push({ id: id || name, name: name });
  });
  if (out.length) return out;
  var sid = str(item.SingerId || item.singerid || item.AuthorId || item.author_id);
  var parts = artistsOf(fallbackName);
  if (sid && parts.length) parts[0].id = sid;
  return parts;
}

function pickHash(item) {
  var trans = item.trans_param || item.TransParam || {};
  // 匿名播放优先 128k FileHash / ogg_128，VIP 哈希在未登录时 tracker 会失败。
  var hashes = [
    item.FileHash, trans.ogg_128_hash, item.hash, item.HQFileHash,
    item.SQFileHash, item.ResFileHash, trans.ogg_320_hash, item.origin_hash
  ];
  for (var i = 0; i < hashes.length; i++) if (validHash(hashes[i])) return String(hashes[i]).toLowerCase();
  return "";
}

function durationMsOf(value) {
  var n = num(value);
  if (n <= 0) return 0;
  return n > 10000 ? n : n * 1000;
}

function songFromSearch(item) {
  var hash = pickHash(item);
  var names = splitArtistTitle(item.FileName || item.filename, item.SingerName || item.singername, item.SongName || item.songname);
  if (!hash || !names.title) return null;
  var cover = secureUrl(item.Image || item.image || (item.trans_param || {}).union_cover);
  return {
    id: hash,
    title: names.title,
    durationMs: durationMsOf(item.Duration || item.duration),
    artworkUrl: cover,
    artworkThumbUrl: thumbUrl(item.Image || item.image || (item.trans_param || {}).union_cover),
    artists: artistsFromItem(item, names.artist),
    album: cleanName(item.AlbumName || item.album_name) ? {
      id: str(item.AlbumID || item.album_id) || cleanName(item.AlbumName || item.album_name),
      name: cleanName(item.AlbumName || item.album_name)
    } : undefined,
    playable: true,
    trial: num(item.Privilege || item.privilege) === 10,
    restricted: num(item.PayType || item.paytype) > 0 && num(item.Privilege || item.privilege) >= 8,
  };
}

function pageArgs(args) {
  var limit = Math.max(1, Math.min(Number(args && args.limit || 20), 100));
  var cursor = String(args && args.cursor || "").trim();
  var page = cursor ? Math.max(1, num(cursor)) : 1;
  return { query: String(args && args.query || "").trim(), limit: limit, page: page };
}

function searchSongs(args) {
  var p = pageArgs(args);
  if (!p.query) return { items: [], nextCursor: "" };
  var url = "http://songsearch.kugou.com/song_search_v2?keyword=" + encodeURIComponent(p.query)
    + "&platform=WebFilter&format=json&page=" + p.page + "&pagesize=" + p.limit
    + "&userid=-1&clientver=&tag=em&filter=2&iscorrection=1&privilege_filter=0&_=" + Date.now();
  return httpGetJson(url, UA_MOBILE).then(function (body) {
    var items = [];
    ((((body.data || {}).lists) || [])).forEach(function (item) {
      var song = songFromSearch(item);
      if (song) items.push(song);
    });
    return { items: items, nextCursor: items.length >= p.limit ? String(p.page + 1) : "" };
  });
}

function searchAlbums(args) {
  var p = pageArgs(args);
  if (!p.query) return { items: [], nextCursor: "" };
  var url = "http://mobilecdn.kugou.com/api/v3/search/album?keyword=" + encodeURIComponent(p.query)
    + "&format=json&page=" + p.page + "&pagesize=" + p.limit;
  return httpGetJson(url, UA_MOBILE).then(function (body) {
    var items = [];
    ((((body.data || {}).info) || [])).forEach(function (item) {
      var id = str(item.albumid);
      var name = cleanName(item.albumname);
      if (!id || !name) return;
      var cover = secureUrl(item.imgurl);
      items.push({
        id: id, name: name, description: str(item.intro),
        artworkUrl: cover, artworkThumbUrl: thumbUrl(item.imgurl),
        trackCount: num(item.songcount),
        artists: artistsOf(item.singername)
      });
    });
    return { items: items, nextCursor: items.length >= p.limit ? String(p.page + 1) : "" };
  });
}

function songDetails(args) {
  var ids = (args && args.ids || []).map(str).filter(validHash).slice(0, 50);
  if (!ids.length) return Promise.resolve([]);
  var out = [];
  return ids.reduce(function (chain, hash) {
    return chain.then(function () {
      return fetchPlayInfo(hash).then(function (info) {
        out.push(songFromSearch({
          hash: hash, SongName: info.songName, SingerName: info.author_name,
          Image: info.album_img, Duration: info.timeLength
        }) || { id: hash, title: info.songName || hash, artists: artistsOf(info.author_name), playable: true });
      }, function () {
        out.push({ id: hash, title: hash, artists: [], playable: true });
      });
    });
  }, Promise.resolve()).then(function () { return out; });
}

function playlistDetails(args) {
  var id = str(args && args.id);
  if (!id) throw new Error("缺少歌单 ID");
  if (id.indexOf("cloudlist:") === 0) return cloudPlaylistDetails(id.slice("cloudlist:".length));
  var infoUrl = "http://mobilecdn.kugou.com/api/v3/special/info?specialid=" + encodeURIComponent(id) + "&version=9108";
  var songUrl = "http://mobilecdn.kugou.com/api/v3/special/song?specialid=" + encodeURIComponent(id)
    + "&page=1&pagesize=300&version=9108&area_code=1";
  return Promise.all([
    httpGetJson(infoUrl, UA_MOBILE).then(function (body) { return (body.data || {}); }, function () { return {}; }),
    httpGetJson(songUrl, UA_MOBILE)
  ]).then(function (both) {
    var info = both[0];
    var songs = [];
    ((((both[1].data || {}).info) || [])).forEach(function (item) {
      var song = songFromSearch(item);
      if (song) songs.push(song);
    });
    var cover = secureUrl(info.imgurl || (songs[0] && songs[0].artworkUrl));
    return {
      id: id,
      name: first(info.specialname, "歌单 " + id),
      description: str(info.intro),
      artworkUrl: cover,
      artworkThumbUrl: thumbUrl(info.imgurl),
      trackCount: num(info.songcount) || songs.length,
      playCount: num(info.playcount),
      owner: { id: "", name: str(info.nickname || info.username) },
      songs: songs
    };
  });
}

function albumDetails(args) {
  var id = str(args && args.id);
  if (!id) throw new Error("缺少专辑 ID");
  var infoUrl = "http://mobilecdn.kugou.com/api/v3/album/info?albumid=" + encodeURIComponent(id) + "&version=9108&area_code=1";
  var songUrl = "http://mobilecdn.kugou.com/api/v3/album/song?albumid=" + encodeURIComponent(id)
    + "&page=1&pagesize=300&version=9108&area_code=1";
  return Promise.all([httpGetJson(infoUrl, UA_MOBILE), httpGetJson(songUrl, UA_MOBILE)]).then(function (both) {
    var info = both[0].data || {};
    var songs = [];
    ((((both[1].data || {}).info) || [])).forEach(function (item) {
      var song = songFromSearch(item);
      if (song) {
        if (!song.album) song.album = { id: id, name: cleanName(info.albumname) };
        songs.push(song);
      }
    });
    var cover = secureUrl(info.imgurl);
    return {
      id: first(info.albumid, id),
      name: first(info.albumname, id),
      description: str(info.intro),
      artworkUrl: cover,
      artworkThumbUrl: thumbUrl(info.imgurl),
      trackCount: num(info.songcount) || songs.length,
      artists: artistsOf(info.singername),
      songs: songs
    };
  });
}

function home(args) {
  var limit = Math.max(1, Math.min(Number(args && args.limit || 30), 100));
  if (args && args.operation === "recommendSongs") return [];
  return httpGetJson("http://m.kugou.com/plist/index&json=true", UA_MOBILE).then(function (body) {
    var playlists = [];
    (((((body.plist || {}).list) || {}).info) || []).forEach(function (item) {
      var id = str(item.specialid);
      var name = cleanName(item.specialname);
      if (!id || !name) return;
      var cover = secureUrl(item.imgurl);
      playlists.push({
        id: id, name: name, description: str(item.intro),
        artworkUrl: cover, artworkThumbUrl: thumbUrl(item.imgurl),
        trackCount: num(item.songcount), playCount: num(item.playcount),
        owner: { id: "", name: str(item.username) }
      });
    });
    return { songs: [], playlists: playlists.slice(0, limit), sections: [] };
  });
}

function stripAudioExt(value) {
  return String(value || "").replace(/\.(mp3|flac|ogg|m4a|aac|wav)$/i, "");
}

function songFromCloud(item) {
  var hash = String(item.hash || "").toLowerCase();
  if (!validHash(hash)) return null;
  var artists = [];
  (item.singerinfo || []).forEach(function (singer) {
    var name = cleanName(singer.name);
    if (name) artists.push({ id: str(singer.id) || name, name: name });
  });
  var raw = stripAudioExt(item.name || item.filename);
  var names = splitArtistTitle(raw, artists.map(function (artist) { return artist.name; }).join("、"), "");
  if (!artists.length) artists = artistsOf(names.artist);
  var album = item.albuminfo || {};
  var cover = item.cover || (item.trans_param || {}).union_cover || "";
  return {
    id: hash,
    title: names.title || raw || hash,
    durationMs: durationMsOf(item.timelen),
    artworkUrl: secureUrl(cover),
    artworkThumbUrl: thumbUrl(cover),
    artists: artists,
    album: cleanName(album.name) ? {
      id: str(album.id) || cleanName(album.name),
      name: cleanName(album.name)
    } : undefined,
    playable: true,
    trial: num(item.media_privilege) === 10,
    restricted: num(item.media_pay_type) > 0 && num(item.media_privilege) >= 8
  };
}

var CLOUD_ROUTER = { "x-router": "cloudlist.service.kugou.com" };

function cloudPlaylistPage(session, page, limit) {
  return gateway.post("/v7/get_all_list", {
    userid: session.userid,
    token: session.token,
    total_ver: 979,
    type: 2,
    page: page,
    pagesize: Math.min(limit, 30)
  }, { plat: "1" }, CLOUD_ROUTER);
}

function userPlaylists(args) {
  var limit = Math.max(1, Math.min(Number(args && args.limit || 50), 100));
  return gateway.auth().then(function (session) {
    if (!session) return [];
    function load(page, acc) {
      return cloudPlaylistPage(session, page, limit).then(function (body) {
        var info = ((body.data || {}).info) || [];
        info.forEach(function (item) {
          if (acc.length >= limit) return;
          var listId = str(item.listid);
          var name = cleanName(item.name || item.specialname);
          if (!listId || listId === "0" || !name) return;
          var cover = item.pic || item.imgurl || "";
          var owned = str(item.list_create_userid) === session.userid || num(item.is_mine) === 1;
          acc.push({
            id: "cloudlist:" + listId,
            name: name,
            description: str(item.intro),
            artworkUrl: secureUrl(cover),
            artworkThumbUrl: thumbUrl(cover),
            trackCount: num(item.count) || num(item.m_count) || num(item.songcount),
            owner: { id: str(item.list_create_userid), name: str(item.list_create_username) },
            owned: owned,
            subscribed: !owned,
            mutable: false,
            deletable: false
          });
        });
        if (info.length < 30 || acc.length >= limit) return acc;
        return load(page + 1, acc);
      });
    }
    return load(1, []);
  });
}

function cloudFiles(session, listId, page, acc) {
  return gateway.post("/v4/get_list_all_file", {
    listid: listId,
    userid: session.userid,
    area_code: 1,
    show_relate_goods: 1,
    pagesize: 300,
    allplatform: 1,
    show_cover: 1,
    type: 0,
    token: session.token,
    page: page
  }, null, CLOUD_ROUTER).then(function (body) {
    var data = body.data || {};
    (data.info || []).forEach(function (item) {
      var song = songFromCloud(item);
      if (song && acc.length < 2000) acc.push(song);
    });
    var total = num(data.count);
    if ((data.info || []).length && acc.length < total && acc.length < 2000 && page < 8) {
      return cloudFiles(session, listId, page + 1, acc);
    }
    return { songs: acc, total: total || acc.length };
  });
}

function cloudPlaylistDetails(listId) {
  if (!listId) throw new Error("缺少歌单 ID");
  return gateway.auth().then(function (session) {
    if (!session) throw new Error("请先登录后查看云歌单");
    return Promise.all([
      cloudPlaylistPage(session, 1, 100).then(function (body) { return ((body.data || {}).info) || []; }, function () { return []; }),
      cloudFiles(session, listId, 1, [])
    ]).then(function (both) {
      var meta = null;
      both[0].forEach(function (item) {
        if (str(item.listid) === listId) meta = item;
      });
      meta = meta || {};
      var cover = meta.pic || meta.imgurl || (both[1].songs[0] && both[1].songs[0].artworkUrl) || "";
      var owned = str(meta.list_create_userid) === session.userid || num(meta.is_mine) === 1;
      return {
        id: "cloudlist:" + listId,
        name: first(meta.name, meta.specialname, "歌单 " + listId),
        description: str(meta.intro),
        artworkUrl: secureUrl(cover),
        artworkThumbUrl: thumbUrl(cover),
        trackCount: num(meta.count) || num(meta.m_count) || both[1].total,
        owner: { id: str(meta.list_create_userid), name: str(meta.list_create_username) },
        owned: owned,
        subscribed: meta.listid != null && !owned,
        mutable: false,
        deletable: false,
        songs: both[1].songs
      };
    });
  });
}

function pickUrl(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Object.prototype.toString.call(value) === "[object Array]") return str(value[0]);
  return "";
}

function fetchPlayInfo(hash) {
  return httpGetJson("http://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=" + encodeURIComponent(hash), UA_MOBILE)
    .then(function (body) {
      if (body.errcode || !body.url) throw new Error("playInfo " + (body.errcode || "empty"));
      return body;
    });
}

function fetchTracker(hash) {
  return Promise.all([md5Hex(hash + "kgcloudv2"), md5Hex(hash + "kgcloud")]).then(function (keys) {
    var urls = [
      "https://trackercdn.kugou.com/i/v2/?cdnBackup=1&behavior=download&pid=1&cmd=21&appid=1001&hash=" + hash + "&key=" + keys[0],
      "http://trackercdnbj.kugou.com/i/v2/?cmd=23&pid=1&behavior=download&hash=" + hash + "&key=" + keys[0],
      "http://trackercdn.kugou.com/i/?cmd=4&pid=1&forceDown=0&vip=1&hash=" + hash + "&key=" + keys[1]
    ];
    function next(i) {
      if (i >= urls.length) throw new Error("暂无播放地址（可能是 VIP/无版权，登录后重试）");
      return httpGetJson(urls[i], UA_PC).then(function (body) {
        var url = pickUrl(body.url) || pickUrl(body.backup_url);
        if (!url || body.errcode) return next(i + 1);
        return { url: url, extName: body.extName, songName: body.songName, author_name: body.author_name, album_img: body.album_img, timeLength: body.timeLength };
      }, function () { return next(i + 1); });
    }
    return next(0);
  });
}

function fetchWebGetData(hash) {
  return httpGetJson("https://wwwapi.kugou.com/yy/index.php?r=play/getdata&hash=" + encodeURIComponent(hash), UA_PC)
    .then(function (body) {
      var data = body.data || {};
      var url = first(data.play_url, data.play_backup_url);
      if (!url) throw new Error("getdata empty");
      return { url: url, extName: data.extName, songName: data.song_name, author_name: data.author_name, album_img: data.img, timeLength: data.timelength };
    });
}

function fetchSonginfoV2(hash) {
  return loadCookies().then(function (cookies) {
    var token = first(cookies.t, cookies.token);
    var userId = first(cookies.KugooID, cookies.userid);
    if (!token || !userId) throw new Error("songinfo v2 需要登录");
    var params = {
      srcappid: "2919", clientver: "20000", clienttime: String(Date.now()),
      mid: first(cookies.mid, cookies.kg_mid, cookies.KUGOU_API_MID, "-"),
      uuid: first(cookies.uuid, cookies.mid, cookies.kg_mid, "-"),
      dfid: first(cookies.dfid, cookies.kg_dfid, "-"),
      appid: "1014", platid: "4", token: token, userid: userId, hash: hash
    };
    return signParams(params, SIGN_KEY).then(function (signature) {
      params.signature = signature;
      return httpGetJson("https://wwwapi.kugou.com/play/songinfo?" + queryOf(params), UA_PC);
    }).then(function (step1) {
      var encodeId = ((step1.data || {}).encode_album_audio_id) || "";
      if (!encodeId) throw new Error("缺少 encode_album_audio_id");
      var params2 = {
        srcappid: "2919", clientver: "20000", clienttime: String(Date.now()),
        mid: params.mid, uuid: params.uuid, dfid: params.dfid, appid: "1014", platid: "4",
        token: token, userid: userId, encode_album_audio_id: encodeId
      };
      return signParams(params2, SIGN_KEY).then(function (signature) {
        params2.signature = signature;
        return httpGetJson("https://wwwapi.kugou.com/play/songinfo?" + queryOf(params2), UA_PC);
      });
    }).then(function (step2) {
      var data = step2.data || {};
      var url = first(data.play_url, data.play_backup_url);
      if (!url) throw new Error("songinfo v2 未返回播放地址");
      return { url: url, extName: data.extname, songName: data.song_name, author_name: data.author_name, album_img: data.img, timeLength: data.timelength };
    });
  });
}

function mimeOf(ext, url) {
  ext = String(ext || url || "").toLowerCase();
  if (ext.indexOf("flac") >= 0) return "audio/flac";
  if (ext.indexOf("ogg") >= 0) return "audio/ogg";
  if (ext.indexOf("m4a") >= 0 || ext.indexOf("aac") >= 0) return "audio/mp4";
  return "audio/mpeg";
}

function asStream(info) {
  var url = secureUrl(info.url || info.URL);
  if (!url) throw new Error("暂无可用播放地址");
  return {
    url: url,
    headers: { "User-Agent": UA_PC, "Referer": "https://www.kugou.com/" },
    mimeType: mimeOf(info.extName, url),
    expiresAtMs: Date.now() + 15 * 60 * 1000,
    trial: false,
    cacheable: false
  };
}

function resolveStream(args) {
  var hash = String(args && args.id || "").toLowerCase();
  if (!validHash(hash)) throw new Error("无效的歌曲 hash");
  return fetchSonginfoV2(hash).then(asStream, function () {
    return fetchPlayInfo(hash).then(asStream, function () {
      return fetchWebGetData(hash).then(asStream, function () {
        return fetchTracker(hash).then(asStream);
      });
    });
  });
}

function artistDetails(args) {
  var id = str(args && args.id);
  if (!id) throw new Error("缺少歌手 ID");
  if (/^\d+$/.test(id)) {
    return Promise.all([
      httpGetJson("http://mobilecdn.kugou.com/api/v3/singer/info?singerid=" + encodeURIComponent(id) + "&version=9108", UA_MOBILE)
        .then(function (body) { return body.data || {}; }, function () { return {}; }),
      httpGetJson("http://mobilecdn.kugou.com/api/v3/singer/song?singerid=" + encodeURIComponent(id)
        + "&page=1&pagesize=50&version=9108", UA_MOBILE)
        .then(function (body) { return ((body.data || {}).info) || []; }, function () { return []; })
    ]).then(function (both) {
      var info = both[0];
      var songs = [];
      both[1].forEach(function (item) {
        var song = songFromSearch(item);
        if (song) songs.push(song);
      });
      var cover = secureUrl(info.imgurl);
      return {
        id: id,
        name: first(info.singername, id),
        artworkUrl: cover,
        artworkThumbUrl: thumbUrl(info.imgurl),
        description: str(info.intro),
        songCount: num(info.songcount) || songs.length,
        songs: songs
      };
    });
  }
  return searchSongs({ query: id, limit: 50, cursor: "" }).then(function (page) {
    var songs = (page.items || []).filter(function (song) {
      return (song.artists || []).some(function (artist) {
        return artist.id === id || artist.name === id;
      });
    });
    return { id: id, name: id, songs: songs.slice(0, 50), songCount: songs.length };
  });
}

function lyricDownloadUrls(candidate) {
  var query = "ver=1&id=" + encodeURIComponent(candidate.id)
    + "&accesskey=" + encodeURIComponent(candidate.accesskey) + "&fmt=krc&charset=utf8";
  // 播放器的 HTTP 客户端连 http://lyrics.kugou.com 会被对端直接掐断（Connection reset），
  // 不是权限拒绝。搜索走 krcs，下载也走同一台，再备一条 HTTPS。
  return [
    "https://krcs.kugou.com/download?" + query + "&client=pc",
    "https://lyrics.kugou.com/download?" + query + "&client=mobi"
  ];
}

function downloadLyric(candidate, index) {
  var urls = lyricDownloadUrls(candidate);
  if (index >= urls.length) return { assets: [] };
  return httpGetJson(urls[index], UA_MOBILE).then(function (dl) {
    var assets = krc.assetsFromDownload(dl, candidate.adjust);
    return assets.length ? { assets: assets } : downloadLyric(candidate, index + 1);
  }, function () { return downloadLyric(candidate, index + 1); });
}

function lyrics(args) {
  var hash = String(args && args.id || "").toLowerCase();
  if (!validHash(hash)) return { assets: [] };
  return httpGetJson("http://krcs.kugou.com/search?ver=1&client=mobi&duration=0&hash=" + hash + "&album_audio_id=", UA_MOBILE)
    .then(function (body) {
      var candidate = (body.candidates || [])[0];
      if (!candidate || !candidate.id || !candidate.accesskey) return { assets: [] };
      return downloadLyric(candidate, 0);
    }, function () { return { assets: [] }; });
}

function account() {
  return loadCookies().then(function (cookies) {
    var uid = first(cookies.userid, cookies.KugooID);
    if (!uid || uid === "0") return { loggedIn: false };
    var fallback = {
      loggedIn: true, id: uid,
      displayName: first(cookies.username, cookies.NickName, "酷狗用户 " + uid),
      avatarUrl: secureUrl(cookies.pic || cookies.photo),
      membershipTier: 0, level: 0, signature: ""
    };
    return httpGetJson("https://vip.kugou.com/recharge/roleinfo", UA_PC).then(function (body) {
      fallback.membershipTier = (num(body.vipRemains) > 0 && num(body.isExpiredMember) === 0 && num(body.role) !== 0) ? 1 : 0;
      return fallback;
    }, function () { return fallback; });
  });
}

function parseCookieString(raw) {
  var parsed = {};
  String(raw || "").split(";").forEach(function (part) {
    var at = part.indexOf("=");
    if (at <= 0) return;
    parsed[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  });
  return parsed;
}

function randomHex(n) {
  var out = "";
  var chars = "0123456789abcdef";
  for (var i = 0; i < n; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

function randomKugouString(length) {
  var chars = "1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  var out = "";
  for (var i = 0; i < length; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

function hexToDec(hex) {
  hex = String(hex || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  var dec = [0];
  for (var i = 0; i < hex.length; i++) {
    var carry = parseInt(hex.charAt(i), 16);
    for (var j = 0; j < dec.length; j++) {
      var v = dec[j] * 16 + carry;
      dec[j] = v % 10;
      carry = (v / 10) | 0;
    }
    while (carry > 0) {
      dec.push(carry % 10);
      carry = (carry / 10) | 0;
    }
  }
  return dec.reverse().join("").replace(/^0+/, "") || "0";
}

function utf8Hex(value) {
  var encoded = unescape(encodeURIComponent(String(value)));
  var out = "";
  for (var i = 0; i < encoded.length; i++) {
    var h = (encoded.charCodeAt(i) & 255).toString(16);
    out += h.length < 2 ? "0" + h : h;
  }
  return out;
}

function rsaEncryptPkcs1(plain) {
  var msgHex = utf8Hex(plain);
  var msgLen = msgHex.length / 2;
  var psLen = 128 - 3 - msgLen;
  if (psLen < 8) return Promise.reject(new Error("RSA 明文过长"));
  return call("crypto.random", { length: psLen + 32, outputEncoding: "hex" }).then(function (rand) {
    var ps = "";
    for (var i = 0; i + 1 < rand.length && ps.length / 2 < psLen; i += 2) {
      var byte = rand.substr(i, 2);
      if (byte !== "00") ps += byte;
    }
    while (ps.length / 2 < psLen) ps += "ff";
    ps = ps.slice(0, psLen * 2);
    return call("crypto.modPow", {
      baseHex: "0002" + ps + "00" + msgHex,
      exponentHex: RSA_E,
      modulusHex: RSA_N,
      width: 256
    });
  }).then(function (hex) { return String(hex || "").toUpperCase(); });
}

function signAndroid(params, data) {
  var pairs = Object.keys(params).map(function (k) { return k + "=" + params[k]; }).sort();
  return md5Hex(LITE_SIGN + pairs.join("") + String(data || "") + LITE_SIGN);
}

function registerDevice(cookies) {
  var seed = randomKugouString(6).toLowerCase();
  return md5Hex(seed).then(function (digest) {
    var key = digest.slice(0, 16);
    var iv = digest.slice(16, 32);
    var device = {
      availableRamSize: 4983533568, availableRomSize: 48114719, availableSDSize: 48114717,
      basebandVer: "", batteryLevel: 100, batteryStatus: 3, brand: "Redmi",
      buildSerial: "unknown", device: "marble", imei: cookies.KUGOU_API_GUID,
      imsi: "", manufacturer: "Xiaomi", uuid: cookies.KUGOU_API_GUID,
      accelerometer: false, accelerometerValue: "", gravity: false, gravityValue: "",
      gyroscope: false, gyroscopeValue: "", light: false, lightValue: "",
      magnetic: false, magneticValue: "", orientation: false, orientationValue: "",
      pressure: false, pressureValue: "", step_counter: false, step_counterValue: "",
      temperature: false, temperatureValue: ""
    };
    return Promise.all([
      call("crypto.aes", {
        transformation: "AES/CBC/PKCS5Padding", operation: "encrypt",
        key: key, keyEncoding: "utf8", iv: iv, ivEncoding: "utf8",
        data: JSON.stringify(device), dataEncoding: "utf8", outputEncoding: "base64"
      }),
      rsaEncryptPkcs1(JSON.stringify({
        aes: seed, uid: cookies.userid, token: cookies.token
      }))
    ]).then(function (both) {
      var data = both[0];
      var clienttime = String(Math.floor(Date.now() / 1000));
      var params = {
        dfid: first(cookies.dfid, "-"),
        mid: first(cookies.KUGOU_API_MID, "-"),
        uuid: "-",
        appid: LITE_APPID,
        clientver: LITE_VER,
        clienttime: clienttime,
        token: cookies.token,
        userid: cookies.userid,
        part: "1",
        platid: "1",
        p: both[1]
      };
      return signAndroid(params, data).then(function (signature) {
        params.signature = signature;
        return call("http.request", {
          url: "https://userservice.kugou.com/risk/v2/r_register_dev?" + queryOf(params),
          method: "POST",
          headers: {
            "User-Agent": "Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi",
            dfid: params.dfid, clienttime: clienttime, mid: params.mid,
            "kg-rc": "1", "kg-thash": "5d816a0", "kg-rec": "1",
            "kg-rf": "B9EDA08A64250DEFFBCADDEE00F8F25F",
            Cookie: cookieHeader(cookies)
          },
          body: data,
          includeBase64: true,
          timeoutMs: 15000
        }).then(function (response) {
          var text = String(response.body || "").trim();
          var parsed = null;
          if (text.charAt(0) === "{") {
            try { parsed = JSON.parse(text); } catch (_) {}
          }
          var done = function (body) {
            if (body && num(body.status) === 1 && body.data && body.data.dfid) {
              cookies.dfid = String(body.data.dfid);
            }
            return cookies;
          };
          if (parsed) return done(parsed);
          if (!response.bodyBase64) return cookies;
          return call("crypto.aes", {
            transformation: "AES/CBC/PKCS5Padding", operation: "decrypt",
            key: key, keyEncoding: "utf8", iv: iv, ivEncoding: "utf8",
            data: response.bodyBase64, dataEncoding: "base64", outputEncoding: "utf8"
          }).then(function (plain) {
            try { return done(JSON.parse(plain)); } catch (_) { return cookies; }
          }, function () { return cookies; });
        });
      });
    });
  }).then(function (out) { return out; }, function () { return cookies; });
}

function loginWebGet(api, extra) {
  var params = {
    dfid: "-", mid: "-", uuid: "-", appid: LITE_APPID, clientver: LITE_VER,
    clienttime: String(Math.floor(Date.now() / 1000))
  };
  Object.keys(extra || {}).forEach(function (key) { params[key] = extra[key]; });
  return signParams(params, SIGN_KEY).then(function (signature) {
    params.signature = signature;
    return call("http.request", {
      url: api + "?" + queryOf(params), method: "GET",
      headers: {
        "User-Agent": "Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi",
        dfid: params.dfid, clienttime: params.clienttime, mid: params.mid
      },
      timeoutMs: 15000
    });
  }).then(function (response) {
    if (response.status < 200 || response.status >= 300) throw new Error("HTTP " + response.status);
    return JSON.parse(response.body || "{}");
  });
}

function login(args) {
  switch (args && args.operation) {
    case "methods":
      return [{
        id: "qr", type: "qr", label: "扫码登录",
        instructions: "打开酷狗 App 扫描二维码并确认。"
      }, {
        id: "cookie", type: "credential", label: "Cookie",
        instructions: "粘贴含 userid/token 或 t/KugooID 的酷狗 Cookie。",
        credentialLabel: "酷狗 Cookie"
      }];
    case "begin":
      if (args.methodId !== "qr") throw new Error("该登录方式不需要创建挑战");
      return loginWebGet("https://login-user.kugou.com/v2/qrcode", {
        appid: "1001", type: "1", plat: "4",
        qrcode_txt: "https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=" + LITE_APPID + "&",
        srcappid: "2919"
      }).then(function (body) {
        var key = str((body.data || {}).qrcode);
        if (!key) throw new Error("未能获取登录二维码");
        return {
          id: key, methodId: "qr", status: "waiting",
          qrContent: "https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=" + encodeURIComponent(key),
          expiresAtMs: Date.now() + 5 * 60 * 1000
        };
      });
    case "poll": {
      var key = str(args.challengeId);
      if (!key) throw new Error("缺少登录挑战 ID");
      return loginWebGet("https://login-user.kugou.com/v2/get_userinfo_qrcode", {
        plat: "4", appid: LITE_APPID, srcappid: "2919", qrcode: key
      }).then(function (body) {
        var status = num((body.data || {}).status);
        if (status === 2 || status === 3) return { id: key, methodId: "qr", status: "scanned" };
        if (status === -1 || status === 5 || status === 6) return { id: key, methodId: "qr", status: "expired" };
        if (status !== 4) return { id: key, methodId: "qr", status: "waiting" };
        var token = str((body.data || {}).token);
        var userId = str((body.data || {}).userid);
        if (!token || !userId || userId === "0") {
          return { id: key, methodId: "qr", status: "failed", message: "登录成功但未返回 token" };
        }
        var guid = randomHex(8) + "-" + randomHex(4) + "-" + randomHex(4) + "-" + randomHex(4) + "-" + randomHex(12);
        return md5Hex(guid).then(function (midHex) {
          var cookies = {
            token: token, userid: userId,
            KUGOU_API_GUID: guid, KUGOU_API_MID: hexToDec(midHex)
          };
          return registerDevice(cookies).then(function (registered) {
            return call("credentials.put", { key: "cookies", value: JSON.stringify(registered) });
          }).then(function () { return account(); }).then(function (profile) {
            return { id: key, methodId: "qr", status: "success", account: profile };
          });
        });
      }, function () { return { id: key, methodId: "qr", status: "waiting" }; });
    }
    case "submit": {
      var parsed = parseCookieString(args.credential);
      if (!first(parsed.userid, parsed.KugooID) && !first(parsed.token, parsed.t)) {
        return { methodId: "cookie", status: "failed", message: "Cookie 中找不到 userid/token" };
      }
      return call("credentials.put", { key: "cookies", value: JSON.stringify(parsed) })
        .then(function () { return account(); })
        .then(function (profile) {
          return { methodId: "cookie", status: "success", account: profile };
        });
    }
    case "logout":
      return call("credentials.delete", { key: "cookies" }).then(function () { return true; }, function () { return true; });
    default:
      throw new Error("未知登录操作");
  }
}

var togetherFeature = require("./together").create({
  request: require("./room").listenTogether,
  songs: function (ids) { return songDetails({ ids: ids }); },
  account: account
});

module.exports = {
  handlers: {
    searchSongs: searchSongs,
    searchAlbums: searchAlbums,
    songDetails: songDetails,
    playlistDetails: playlistDetails,
    albumDetails: albumDetails,
    artistDetails: artistDetails,
    home: home,
    userPlaylists: userPlaylists,
    resolveStream: resolveStream,
    lyrics: lyrics,
    account: account,
    login: login,
    backgroundTick: togetherFeature.tick,
    "ui.listen-together": togetherFeature.ui
  }
};
