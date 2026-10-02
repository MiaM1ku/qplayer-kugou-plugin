"use strict";

// 概念版 Android 网关。签名盐、appid 和 body 必须是同一段 JSON，否则云列表会 20006。

var LITE_SIGN = "LnT6xpN3khm36zse0QzvmgTZ3waWdRSA";
var LITE_APPID = "3116";
var LITE_VER = "11440";
var UA = "Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi";

function call(method, args) { return qplayer.call(method, args || {}); }

function first() {
  for (var i = 0; i < arguments.length; i++) {
    var value = arguments[i] == null ? "" : String(arguments[i]).trim();
    if (value) return value;
  }
  return "";
}

function loadCookies() {
  return call("credentials.get", { key: "cookies" }).then(function (stored) {
    if (!stored) return {};
    try { return JSON.parse(stored); } catch (_) { return {}; }
  }, function () { return {}; });
}

function queryOf(params) {
  return Object.keys(params).map(function (key) {
    return encodeURIComponent(key) + "=" + encodeURIComponent(params[key]);
  }).join("&");
}

function sign(params, data) {
  var pairs = Object.keys(params).map(function (key) { return key + "=" + params[key]; }).sort();
  return call("crypto.digest", {
    algorithm: "MD5",
    data: LITE_SIGN + pairs.join("") + String(data || "") + LITE_SIGN,
    dataEncoding: "utf8",
    outputEncoding: "hex"
  });
}

function auth() {
  return loadCookies().then(function (cookies) {
    var userid = first(cookies.userid, cookies.KugooID);
    var token = first(cookies.token, cookies.t);
    if (!userid || userid === "0" || !token) return null;
    return { userid: userid, token: token };
  });
}

function request(method, path, query, data, headers) {
  return loadCookies().then(function (cookies) {
    var userid = first(cookies.userid, cookies.KugooID);
    var token = first(cookies.token, cookies.t);
    if (!userid || userid === "0" || !token) {
      var missing = new Error("请先登录");
      missing.code = 0;
      throw missing;
    }
    var params = {
      dfid: first(cookies.dfid, "-"),
      mid: first(cookies.KUGOU_API_MID, cookies.mid, "-"),
      uuid: "-",
      appid: LITE_APPID,
      clientver: LITE_VER,
      clienttime: String(Math.floor(Date.now() / 1000)),
      token: token,
      userid: userid
    };
    Object.keys(query || {}).forEach(function (key) {
      if (query[key] != null && query[key] !== "") params[key] = String(query[key]);
    });
    var body = data == null ? "" : JSON.stringify(data);
    return sign(params, body).then(function (signature) {
      params.signature = signature;
      var all = {
        "User-Agent": UA,
        dfid: params.dfid,
        clienttime: params.clienttime,
        mid: params.mid
      };
      if (data != null) all["Content-Type"] = "application/json";
      Object.keys(headers || {}).forEach(function (key) { all[key] = headers[key]; });
      return call("http.request", {
        url: "https://gateway.kugou.com" + path + "?" + queryOf(params),
        method: method,
        headers: all,
        body: data == null ? undefined : body,
        timeoutMs: 15000
      });
    });
  }).then(function (response) {
    if (!response || response.status < 200 || response.status >= 300) {
      var httpError = new Error("HTTP " + (response && response.status));
      httpError.code = response ? Number(response.status) : 0;
      throw httpError;
    }
    var parsed;
    try { parsed = JSON.parse(response.body || "{}"); }
    catch (_) { throw new Error("酷狗响应不是 JSON"); }
    var code = parsed.errcode != null ? parsed.errcode : parsed.error_code;
    if (Number(parsed.status) === 1 && Number(code || 0) === 0) return parsed;
    var failed = new Error(String(parsed.error || parsed.error_msg || ("酷狗错误 " + code)));
    failed.code = Number(code || 0);
    throw failed;
  });
}

function post(path, data, query, headers) {
  return request("POST", path, query, data == null ? {} : data, headers);
}

function get(path, query, headers) {
  return request("GET", path, query, null, headers);
}

module.exports = { auth: auth, post: post, get: get };
