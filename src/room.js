"use strict";

// 概念版一起听。创建房间会被实名（20028）拦住；加入只校验房间号。
// 播放状态以 music_sync_player 为准，不是网易云那种命令流。

var gateway = require("./gateway");
var BIZ = "1009";
var DEFAULT_BG = "https://youthimgbssdl.kugou.com/6e9cdcef8d163d06225d8cbeaa2f1ece.JPEG";
var mixIds = {};

function text(value) { return value == null ? "" : String(value); }
function validHash(value) {
  value = text(value).toLowerCase();
  return /^[a-f0-9]{32}$/.test(value) && value !== "00000000000000000000000000000000";
}

function explain(error) {
  var code = error && error.code;
  if (code === 20028) return new Error("创建房间需要先在酷狗完成实名认证");
  if (code === 20002 || code === 55006) return new Error("房间不存在");
  return error instanceof Error ? error : new Error(text(error && error.message || error) || "一起听请求失败");
}

function fail(error) { throw explain(error); }

function authBody() {
  return gateway.auth().then(function (session) {
    if (!session) throw new Error("请先登录后使用一起听");
    return { userid: Number(session.userid), token: session.token };
  });
}

function remember(hash, mixsongid) {
  hash = text(hash).toLowerCase();
  if (!validHash(hash) || mixsongid == null || mixsongid === "") return;
  mixIds[hash] = text(mixsongid);
}

function audio(hash) {
  hash = text(hash).toLowerCase();
  return { hash: hash, mixsongid: mixIds[hash] || "", fid: 0 };
}

function audios(ids) {
  var out = [];
  (ids || []).forEach(function (id) {
    var hash = text(id).toLowerCase();
    if (!validHash(hash) || out.length >= 50) return;
    out.push(audio(hash));
  });
  return out;
}

function groupBody(session, roomId, extra) {
  var body = {
    userid: session.userid,
    token: session.token,
    biz: BIZ,
    groupid: text(roomId)
  };
  Object.keys(extra || {}).forEach(function (key) { body[key] = extra[key]; });
  return body;
}

function roomIdOf(body, fallback) {
  var data = (body && body.data) || {};
  return text(data.groupid || data.group_id || data.roomid || data.room_id || fallback);
}

function roomDto(id, owner, heartbeat, members) {
  return {
    id: text(id),
    owner: !!owner,
    heartbeatSec: Math.max(20, Number(heartbeat || 60) - 10),
    members: members || []
  };
}

function membersOf(body) {
  var data = body && body.data;
  var list = data && (data.list || data.members || data.info || data.user_list);
  if (!Array.isArray(list) && Array.isArray(data)) list = data;
  if (!Array.isArray(list)) return [];
  return list.map(function (user) {
    user = user || {};
    return {
      id: text(user.userid || user.user_id || user.uid),
      displayName: text(user.nick_name || user.nickname || user.name)
    };
  }).filter(function (member) { return member.id || member.displayName; }).slice(0, 24);
}

function collectSongs(value, out, depth) {
  if (value == null || depth > 6) return;
  if (typeof value === "string") {
    var hash = value.toLowerCase();
    if (validHash(hash) && !out.some(function (song) { return song.hash === hash; })) {
      out.push({ hash: hash, mixsongid: "", timelen: 0 });
    }
    return;
  }
  if (Object.prototype.toString.call(value) === "[object Array]") {
    value.forEach(function (item) { collectSongs(item, out, depth + 1); });
    return;
  }
  if (typeof value !== "object") return;
  var hash = text(value.hash || value.FileHash || value.audio_hash).toLowerCase();
  if (validHash(hash) && !out.some(function (song) { return song.hash === hash; })) {
    var mix = value.mixsongid || value.MixSongID || value.album_audio_id || "";
    remember(hash, mix);
    out.push({ hash: hash, mixsongid: text(mix), timelen: Number(value.timelen || value.duration || 0) || 0 });
  }
  ["song_info", "info", "list", "songs", "audios"].forEach(function (key) {
    if (value[key]) collectSongs(value[key], out, depth + 1);
  });
}

function progressMs(raw, durationMs) {
  var n = Number(raw || 0);
  if (!isFinite(n) || n <= 0) return 0;
  var seconds = durationMs > 1000 && n <= durationMs / 1000 + 2;
  var millis = durationMs > 1000 && !seconds && n <= durationMs + 2000;
  if (millis || n > 10000) return Math.floor(n);
  return Math.floor(n * 1000);
}

function outboundProgress(positionMs) {
  return Math.max(0, Math.floor(Number(positionMs || 0) / 1000));
}

function snapshotFrom(syncBody, listBody) {
  var data = (syncBody && syncBody.data) || {};
  var progress = data.progress_info || {};
  var songs = [];
  collectSongs(data.song_info || data, songs, 0);
  if (listBody) collectSongs(listBody.data || listBody, songs, 0);
  var current = text(progress.cur_song || progress.hash || data.cur_song).toLowerCase();
  if (!validHash(current)) current = songs.length ? songs[0].hash : "";
  if (current && !songs.some(function (song) { return song.hash === current; })) {
    songs.unshift({ hash: current, mixsongid: mixIds[current] || "", timelen: 0 });
  }
  var duration = 0;
  songs.forEach(function (song) {
    if (song.hash === current && song.timelen) duration = song.timelen;
  });
  var rawProgress = progress.progress != null ? progress.progress
    : (progress.play_progress != null ? progress.play_progress : data.progress);
  var pause = data.pause != null ? data.pause : progress.pause;
  var playing = null;
  if (Number(pause) === 1) playing = true;
  if (Number(pause) === 2) playing = false;
  return {
    songIds: songs.map(function (song) { return song.hash; }).slice(0, 50),
    currentSongId: current,
    playing: playing,
    progressMs: rawProgress == null || rawProgress === ""
      ? null
      : progressMs(rawProgress, duration > 10000 ? duration : 0),
    listVersion: text(data.list_version || data.listVersion)
  };

}

function syncPlayer(roomId) {
  return gateway.post("/youth/v1/genting/music_sync_player", {}, { roomid: roomId, frm: "2" });
}

function fetchList(roomId) {
  return gateway.post("/youth/v1/genting/music_fetch_list", { pagesize: 50 }, { roomid: roomId });
}

function withSession(work) {
  return authBody().then(work, fail);
}

function listenTogether(args) {
  args = args || {};
  var roomId = text(args.roomId);
  switch (args.operation) {
    case "status":
      return withSession(function (session) {
        return gateway.post("/rmservice/v1/user/get_status", groupBody(session, "")).then(function (body) {
          var data = body.data || {};
          var id = text(data.groupid);
          if (!id) return { inRoom: false, room: null };
          return {
            inRoom: true,
            room: roomDto(id, Number(data.is_owner) === 1, 60, [])
          };
        });
      });
    case "create":
      return withSession(function (session) {
        var hashes = audios(args.songIds);
        if (!hashes.length) throw new Error("请先播放一首酷狗歌曲");
        var bg = JSON.stringify({ bg_img: DEFAULT_BG, room_bg_type: "2" });
        return gateway.post("/rmservice/v1/group/create", {
          userid: session.userid,
          token: session.token,
          biz: BIZ,
          pass_through_data: {
            room_privacy: 1,
            cp_notice: 1,
            room_bg_content: bg,
            global_collection_id: ""
          },
          introduction: ""
        }).then(function (created) {
          var id = roomIdOf(created, "");
          if (!id) throw new Error("创建房间未返回房间号");
          var current = hashes[0].hash;
          return gateway.post("/youth/v1/genting/init_musicroom", {
            sendall: 1,
            audios: hashes,
            progress_info: { play_mode: 1, cur_song: current }
          }, { roomid: id }).then(function () {
            return roomDto(id, true, (created.data || {}).heartbeat_interval, []);
          }, function (error) {
            return gateway.post("/rmservice/v1/group/dismiss", groupBody(session, id))
              .then(function () { fail(error); }, function () { fail(error); });
          });
        });
      }).then(null, fail);
    case "join":
      return withSession(function (session) {
        if (!roomId) throw new Error("缺少房间号");
        return gateway.post("/rmservice/v1/group/join", groupBody(session, roomId, {
          pass_through_data: { cp_notice: 1 }
        })).then(function () {
          return gateway.post("/rmservice/v1/user/get_status", groupBody(session, roomId));
        }).then(function (body) {
          var data = body.data || {};
          var id = text(data.groupid) || roomId;
          return roomDto(id, Number(data.is_owner) === 1, 60, []);
        });
      }).then(null, fail);
    case "snapshot":
      return syncPlayer(roomId).then(function (syncBody) {
        var version = text(((syncBody.data || {}).list_version));
        var needList = !args.listVersion || !version || version !== text(args.listVersion);
        var listed = needList ? fetchList(roomId).then(null, function () { return null; }) : Promise.resolve(null);
        var people = args.members
          ? gateway.get("/youth/v1/genting/get_musicroom_member", {
            roomid: roomId, page: "1", pagesize: "100", apiver: "3"
          }).then(membersOf, function () { return []; })
          : Promise.resolve(null);
        return Promise.all([listed, people]).then(function (both) {
          var snapshot = snapshotFrom(syncBody, both[0]);
          if (both[1]) snapshot.members = both[1];
          return snapshot;
        });
      }).then(null, fail);
    case "add":
      return gateway.post("/youth/v1/genting/music_add", {
        action: 4,
        list_version: text(args.listVersion),
        sendall: 1,
        audios: audios(args.songIds)
      }, { roomid: roomId }).then(function () { return true; }, fail);
    case "switch":
      return gateway.post("/youth/v1/genting/music_sw", {
        act_type: 1,
        list_version: text(args.listVersion),
        is_auto: args.auto ? "1" : "0",
        audio: audio(args.songId)
      }, { roomid: roomId }).then(function () { return true; }, fail);
    case "seek":
      return gateway.post("/youth/v1/genting/music_player_opr", {
        action: 2,
        progress: outboundProgress(args.progressMs)
      }, { roomid: roomId }).then(function () { return true; }, fail);
    case "playing":
      return gateway.post("/youth/v1/genting/music_player_opr", {
        action: 3,
        pause: args.playing ? "1" : "2"
      }, { roomid: roomId }).then(function () { return true; }, fail);
    case "heartbeat":
      return withSession(function (session) {
        return gateway.post("/rmservice/v1/group/heartbeat", groupBody(session, roomId))
          .then(function () { return true; });
      }).then(null, fail);
    case "end":
      return withSession(function (session) {
        var path = args.owner ? "/rmservice/v1/group/dismiss" : "/rmservice/v1/group/leave";
        return gateway.post(path, groupBody(session, roomId)).then(function () { return true; }, function (error) {
          if (!args.owner) fail(error);
          return gateway.post("/rmservice/v1/group/leave", groupBody(session, roomId))
            .then(function () { return true; }, fail);
        });
      });
    default:
      throw new Error("未知一起听操作");
  }
}

module.exports = { listenTogether: listenTogether };
