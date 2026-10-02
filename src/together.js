"use strict";

function create(api) {
  var state = {
    initialized: false, initializing: null, inRoom: false, busy: false,
    room: null, accountId: "", error: "",
    lastSongId: "", lastQueue: "", lastPlaying: false, lastSeekRevision: 0,
    lastEndRevision: 0, remoteQueue: [], listVersion: "",
    pendingEndAt: 0, ticks: 0, lastInitAttempt: 0, lastHeartbeatAt: 0,
    reportBlockedUntil: 0, applyingRemote: false,
    remoteProgressMark: "", remoteProgressAt: 0
  };

  function call(method, args) { return qplayer.call(method, args || {}); }
  function text(value) { return String(value == null ? "" : value); }
  function idsSignature(values) { return (values || []).map(String).join(","); }
  function message(error) {
    var value = text(error && error.message || error);
    return value || "未知错误";
  }
  function notify(value) {
    return call("notifications.toast", { message: value }).then(function () { return true; });
  }
  function plain(value, limit) {
    var out = text(value).replace(/[\u0000-\u001f\u007f]/g, " ");
    return out.length > limit ? out.slice(0, limit) : out;
  }
  function memberNames(room) {
    return ((room && room.members) || []).map(function (member) {
      return text(member.displayName || member.id);
    }).filter(Boolean).join("、");
  }
  function invitation() {
    if (!state.inRoom || !state.room) return "";
    return "qplayer://listen-together?provider=kugou&roomId="
      + encodeURIComponent(state.room.id);
  }
  function publicState() {
    var body = [];
    body.push({
      type: "text", style: "title", center: true,
      text: state.inRoom
        ? ((state.room && state.room.members && state.room.members.length)
          ? state.room.members.length + " 人正在一起听" : "正在一起听")
        : "尚未加入房间"
    });
    if (state.inRoom) {
      body.push({
        type: "text", style: "caption", center: true,
        text: plain(memberNames(state.room), 200)
          || ("房间 " + plain(state.room && state.room.id, 64))
      });
      body.push({ type: "text", style: "body", text: plain(invitation(), 300) });
      body.push({
        type: "row", items: [
          { type: "button", id: "copy", label: "复制邀请", style: "filled" },
          {
            type: "button", id: "leave",
            label: state.room && state.room.owner ? "解散房间" : "退出房间",
            style: "outlined", destructive: true
          }
        ]
      });
    } else {
      body.push({
        type: "text", style: "caption", center: true,
        text: "加入好友的房间。创建房间需要酷狗已实名。"
      });
      body.push({ type: "input", id: "invitation", placeholder: "邀请链接或房间号" });
      body.push({
        type: "row", items: [
          { type: "button", id: "create", label: "创建房间", style: "filled" },
          { type: "button", id: "join", label: "加入房间", style: "outlined" }
        ]
      });
    }
    if (state.error) body.push({ type: "error", text: plain(state.error, 280) });
    return {
      title: "一起听",
      subtitle: "酷狗音乐",
      icon: "group",
      refreshMs: 1500,
      body: body
    };
  }
  function playback() { return call("playback.read", {}); }
  function blockAutoAdvance(blocked) {
    return call("playback.blockAutoAdvance", { blocked: !!blocked });
  }
  function setRoom(room) {
    state.room = room || null;
    state.inRoom = !!(room && room.id);
    state.pendingEndAt = 0;
    if (room && room.members) state.room.members = room.members;
    return blockAutoAdvance(state.inRoom);
  }
  function clearRoom() {
    state.inRoom = false;
    state.room = null;
    state.lastSongId = "";
    state.lastQueue = "";
    state.remoteQueue = [];
    state.listVersion = "";
    state.pendingEndAt = 0;
    state.applyingRemote = false;
    state.remoteProgressMark = "";
    state.remoteProgressAt = 0;
    return blockAutoAdvance(false);
  }
  function baseline(snapshot) {
    state.lastSongId = text(snapshot.currentSongId);
    state.lastQueue = idsSignature(snapshot.queueSongIds);
    state.lastPlaying = !!snapshot.playing;
    state.lastSeekRevision = Number(snapshot.seekRevision || 0);
    state.lastEndRevision = Number(snapshot.endRevision || 0);
  }
  function windowIds(ids, current) {
    var list = (ids || []).map(String).filter(Boolean).slice(0, 50);
    if (current && list.indexOf(current) < 0) list = [current].concat(list).slice(0, 50);
    return list;
  }
  function rememberProgress(remote) {
    var playing = remote.playing == null ? "" : (remote.playing ? "1" : "0");
    var mark = text(remote.currentSongId) + "|" + playing + "|"
      + (remote.progressMs == null ? "" : String(remote.progressMs));
    if (mark !== state.remoteProgressMark) {
      state.remoteProgressMark = mark;
      state.remoteProgressAt = Date.now();
    }
  }
  function expectedProgress(remote) {
    if (remote.progressMs == null) return null;
    var base = Math.max(0, Number(remote.progressMs || 0));
    if (!remote.playing) return base;
    return base + Math.max(0, Date.now() - Number(state.remoteProgressAt || Date.now()));
  }
  function applyRemote(remote, followPlayback) {
    remote = remote || {};
    if (remote.listVersion) state.listVersion = text(remote.listVersion);
    if (remote.members && state.room) state.room.members = remote.members;
    rememberProgress(remote);
    if (followPlayback === false) return playback();
    var remoteIds = windowIds(remote.songIds, text(remote.currentSongId));
    if (!remoteIds.length && !remote.currentSongId) return playback();
    return playback().then(function (local) {
      var song = text(remote.currentSongId) || remoteIds[0] || text(local.currentSongId);
      var playing = remote.playing == null ? !!local.playing : !!remote.playing;
      var knownProgress = remote.progressMs != null;
      var position = knownProgress ? expectedProgress(remote) : Number(local.positionMs || 0);
      var queueChanged = remoteIds.length && idsSignature(remoteIds) !== idsSignature(local.queueSongIds);
      var sameSong = song && song === text(local.currentSongId);
      var drift = Math.abs(Number(local.positionMs || 0) - position);
      var tolerance = playing ? 8000 : 1500;
      if (!queueChanged && sameSong && !!local.playing === playing && (!knownProgress || drift < tolerance)) {
        state.remoteQueue = remoteIds.length ? remoteIds.slice() : state.remoteQueue;
        return local;
      }
      state.applyingRemote = true;
      var action;
      if (queueChanged) {
        var selected = remoteIds.indexOf(song) >= 0 ? song : remoteIds[0];
        action = api.songs(remoteIds).then(function (songs) {
          return call("queue.replace", {
            songs: songs, currentSongId: selected, positionMs: position, playing: playing
          });
        });
      } else if (song && !sameSong) {
        action = call("playback.select", { songId: song, positionMs: position, playing: playing });
      } else if (!!local.playing !== playing) {
        action = playing ? call("playback.play", {}) : call("playback.pause", {});
      } else if (knownProgress) {
        action = call("playback.seek", { positionMs: position });
      } else {
        state.applyingRemote = false;
        return local;
      }
      return action.then(function () {
        state.remoteQueue = remoteIds.length ? remoteIds.slice() : state.remoteQueue;
        return playback();
      });
    }).then(function (after) {
      baseline(after);
      if (!after.transitioning) state.applyingRemote = false;
      return after;
    });
  }
  function reportLocal(snapshot) {
    if (!state.room || !state.room.owner) return Promise.resolve(true);
    if (state.applyingRemote || snapshot.transitioning) {
      if (!snapshot.transitioning) state.applyingRemote = false;
      baseline(snapshot);
      return Promise.resolve(true);
    }
    if (Date.now() < state.reportBlockedUntil) {
      baseline(snapshot);
      return Promise.resolve(true);
    }
    var queue = (snapshot.queueSongIds || []).map(String).filter(Boolean);
    var added = queue.filter(function (id) { return state.remoteQueue.indexOf(id) < 0; });
    var song = text(snapshot.currentSongId);
    var work = Promise.resolve(true);
    if (added.length) {
      work = work.then(function () {
        return api.request({
          operation: "add", roomId: state.room.id, listVersion: state.listVersion, songIds: added
        });
      });
    }
    if (song && song !== state.lastSongId) {
      work = work.then(function () {
        return api.request({
          operation: "switch", roomId: state.room.id, listVersion: state.listVersion, songId: song
        });
      });
    } else if (Number(snapshot.seekRevision || 0) !== state.lastSeekRevision && song) {
      work = work.then(function () {
        return api.request({
          operation: "seek", roomId: state.room.id, progressMs: snapshot.positionMs
        });
      });
    } else if (!!snapshot.playing !== state.lastPlaying && song) {
      work = work.then(function () {
        return api.request({
          operation: "playing", roomId: state.room.id, playing: !!snapshot.playing,
          progressMs: snapshot.positionMs
        });
      });
    }
    return work.then(function () {
      state.remoteQueue = queue.slice();
      baseline(snapshot);
      return true;
    }, function (error) {
      state.reportBlockedUntil = Date.now() + 30000;
      baseline(snapshot);
      throw error;
    });
  }
  function handleNaturalEnd(snapshot) {
    if (!state.room || !state.room.owner) return Promise.resolve(true);
    var revision = Number(snapshot.endRevision || 0);
    if (revision !== state.lastEndRevision) {
      state.lastEndRevision = revision;
      state.pendingEndAt = 0;
      return call("playback.next", {});
    }
    return Promise.resolve(true);
  }
  function restore() {
    return api.account().then(function (profile) {
      state.accountId = profile && profile.loggedIn ? text(profile.id) : "";
      if (!state.accountId) {
        state.initialized = true;
        return clearRoom();
      }
      return api.request({ operation: "status" }).then(function (status) {
        if (!status || !status.inRoom || !status.room || !status.room.id) {
          state.initialized = true;
          return clearRoom();
        }
        return setRoom(status.room).then(function () {
          return api.request({
            operation: "snapshot", roomId: state.room.id, members: true
          });
        }).then(applyRemote).then(function () {
          state.initialized = true;
          state.lastHeartbeatAt = Date.now();
          return true;
        });
      });
    });
  }
  function ensureInitialized() {
    if (state.initialized) return Promise.resolve();
    if (state.initializing) return state.initializing;
    var now = Date.now();
    if (now - state.lastInitAttempt < 5000) return Promise.resolve();
    state.lastInitAttempt = now;
    state.initializing = restore().then(function () {
      state.error = "";
      state.initializing = null;
    }, function (error) {
      state.error = message(error);
      state.initializing = null;
    });
    return state.initializing;
  }
  function tick() {
    state.ticks++;
    if (state.busy) return true;
    if (!state.inRoom) {
      if (state.initialized && state.ticks % 10 !== 0) return true;
      if (state.initializing) return true;
      if (!state.initialized && Date.now() - state.lastInitAttempt < 5000) return true;
      state.initialized = false;
      return ensureInitialized().then(function () { return true; }, function () { return true; });
    }
    return ensureInitialized().then(function () {
      return blockAutoAdvance(true).then(playback).then(function (local) {
        return handleNaturalEnd(local).then(function () { return playback(); });
      }).then(reportLocal).then(function () {
        return api.request({
          operation: "snapshot",
          roomId: state.room.id,
          listVersion: state.listVersion,
          members: state.ticks % 12 === 0
        });
      }).then(function (snapshot) {
        return applyRemote(snapshot, !(state.room && state.room.owner));
      }).then(function () {
        var interval = Math.max(20, Number(state.room.heartbeatSec || 50)) * 1000;
        if (Date.now() - state.lastHeartbeatAt < interval) return true;
        state.lastHeartbeatAt = Date.now();
        return api.request({ operation: "heartbeat", roomId: state.room.id });
      }).then(function () {
        if (state.ticks % 12 !== 0) return true;
        return api.request({ operation: "status" }).then(function (status) {
          if (!status || !status.inRoom || !status.room || !status.room.id) return clearRoom();
          state.room.owner = !!status.room.owner;
          if (!state.room.members.length && status.room.members) state.room.members = status.room.members;
          return true;
        });
      }).then(function () {
        state.error = "";
        return true;
      }, function (error) {
        state.error = message(error);
        return true;
      });
    });
  }
  function parseInvitation(value) {
    var raw = text(value).trim();
    if (!raw) return { error: "请输入邀请链接或房间号" };
    if (raw.length > 1024) return { error: "邀请内容过长" };
    var query = raw.indexOf("?") >= 0 ? raw.slice(raw.indexOf("?") + 1) : raw;
    var result = {};
    try {
      query.split("&").forEach(function (part) {
        var at = part.indexOf("=");
        if (at > 0) result[decodeURIComponent(part.slice(0, at))] = decodeURIComponent(part.slice(at + 1));
      });
    } catch (_) {
      return { error: "邀请链接编码无效" };
    }
    if (!result.roomId && raw.indexOf("=") < 0 && raw.indexOf("/") < 0) result.roomId = raw;
    result.roomId = text(result.roomId).trim();
    if (result.provider && result.provider !== "kugou") return { error: "这不是酷狗一起听邀请" };
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(result.roomId)) return { error: "房间号格式无效" };
    return result;
  }
  function operation(work) {
    if (state.busy) return Promise.resolve(publicState());
    state.busy = true;
    state.error = "";
    return work().then(function () {
      state.busy = false;
      return publicState();
    }, function (error) {
      state.busy = false;
      state.error = message(error);
      return publicState();
    });
  }
  function createRoom() {
    return operation(function () {
      var local;
      return Promise.all([api.account(), playback()]).then(function (values) {
        var profile = values[0];
        local = values[1];
        if (!profile || !profile.loggedIn) throw new Error("请先登录后使用一起听");
        if (!local.currentSongId) throw new Error("请先播放一首酷狗歌曲");
        state.accountId = text(profile.id);
        var ids = (local.queueSongIds || []).slice();
        if (ids.indexOf(local.currentSongId) < 0) ids.unshift(local.currentSongId);
        return api.request({ operation: "create", songIds: ids });
      }).then(setRoom).then(function () {
        state.remoteQueue = (local.queueSongIds || []).map(String);
        state.lastHeartbeatAt = Date.now();
        baseline(local);
        return notify("一起听房间已创建");
      });
    });
  }
  function joinRoom(invitationValue) {
    var parsed = parseInvitation(invitationValue);
    if (parsed.error) {
      state.error = parsed.error;
      return Promise.resolve(publicState());
    }
    return operation(function () {
      return api.account().then(function (profile) {
        if (!profile || !profile.loggedIn) throw new Error("请先登录后使用一起听");
        state.accountId = text(profile.id);
        return api.request({ operation: "join", roomId: parsed.roomId });
      }).then(setRoom).then(function () {
        return api.request({ operation: "snapshot", roomId: state.room.id, members: true });
      }).then(applyRemote).then(function () {
        state.lastHeartbeatAt = Date.now();
        return notify("已加入一起听");
      });
    });
  }
  function leaveRoom() {
    return operation(function () {
      if (!state.inRoom || !state.room) return true;
      var id = state.room.id;
      var owner = !!state.room.owner;
      return api.request({ operation: "end", roomId: id, owner: owner }).then(clearRoom)
        .then(function () { return notify(owner ? "已解散一起听" : "已退出一起听"); });
    });
  }
  function ui(args) {
    args = args || {};
    var action = text(args.action);
    var inputs = (args.payload || {}).inputs || {};
    if (action === "open" || action === "refresh" || action === "status") {
      return ensureInitialized().then(publicState);
    }
    if (action === "create") return createRoom();
    if (action === "join") {
      var invitationValue = text(inputs.invitation).trim();
      if (!invitationValue) {
        state.error = "";
        return Promise.resolve(publicState());
      }
      return joinRoom(invitationValue);
    }
    if (action === "leave") return leaveRoom();
    if (action === "copy") {
      var value = invitation();
      if (!value) return Promise.resolve(publicState());
      return call("clipboard.write", { text: value })
        .then(function () { return notify("已复制一起听邀请"); })
        .then(publicState);
    }
    throw new Error("未知一起听界面操作");
  }

  return { tick: tick, ui: ui };
}

module.exports = { create: create };
