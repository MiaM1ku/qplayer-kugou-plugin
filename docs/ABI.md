# QPlayer 插件 ABI 1.0

<p><b>简体中文</b> · <a href="ABI.en.md">English</a></p>

本文档描述 QPlayer 与音源插件之间的全部约定：handler 收到的参数、必须返回的结构，
以及宿主会拒绝的输入。

QPlayer 本体不包含在线音源。搜索、歌单、播放地址、歌词、登录均由用户自行安装的
`.qplug` 包提供。宿主负责三件事：在隔离环境中运行插件、校验插件返回的每一个字段、
将结果渲染为界面。下述限制来自宿主必须将插件视为未经审阅的第三方代码这一前提。

---

## 一、运行方式

插件是 CommonJS JavaScript，运行在嵌入的 Rhino 引擎中，每个插件一个独立 Realm。
插件无法访问 Java 类、`Packages`、文件系统、其他插件的数据以及 QPlayer 的 QML 场景。
唯一的外部接口是全局对象 `qplayer`。

每个插件对应一条 actor 线程，handler 串行执行，因此不存在并发问题。单次调用超过
**90 秒**会被中断。

```js
module.exports = {
  handlers: {
    searchSongs: function (args) {
      return qplayer.call("http.request", {
        url: "https://api.example.com/search?q=" + encodeURIComponent(args.query),
        method: "GET"
      }).then(function (response) {
        var data = JSON.parse(response.body);
        return {
          items: data.songs.map(toSongDto),
          nextCursor: data.hasMore ? String(data.offset + data.songs.length) : ""
        };
      });
    }
  }
};
```

handler 可以返回值或 Promise。`require()` 只能加载包内的相对路径 `.js` 文件，
单个模块不超过 4 MiB。

清单中声明的能力必须全部实现。插件启动时宿主逐个检查 `handlers[capability]` 是否
存在，缺少任意一个则拒绝启用，避免界面上出现无响应的入口。

---

## 二、`plugin.json`

```json
{
  "schemaVersion": 1,
  "id": "example",
  "name": "Example Source",
  "version": "1.0.0",
  "apiVersion": "1.0",
  "minHostVersion": "1.5.0",
  "entry": "src/main.js",
  "capabilities": ["searchSongs", "resolveStream", "lyrics"],
  "permissions": ["network"],
  "networkDomains": ["api.example.com", "*.cdn.example.com"],
  "networkMethods": ["GET", "POST"],
  "ui": []
}
```

| 字段 | 说明 |
|---|---|
| `schemaVersion` | 固定 `1` |
| `id` | 插件/音源标识，同时是所有媒体 ID 的前缀。`local` 为宿主保留 |
| `name` | 显示名，≤80 字符 |
| `version` | 插件版本，发版 tag 必须与之一致 |
| `apiVersion` | 当前为 `1.0` |
| `minHostVersion` | 可选。低于该版本的 QPlayer 拒绝安装 |
| `entry` | 入口 JS，包内相对路径 |
| `capabilities` | 见第四节，仅声明已实现的能力 |
| `permissions` | 见下表，仅声明实际使用的权限 |
| `networkDomains` | 精确域名或 `*.example.com`，需同时声明 `network` 权限 |
| `networkMethods` | `GET`/`POST`/`PUT`/`PATCH`/`DELETE`/`HEAD` 的子集，留空等价于 `["GET","POST"]` |
| `ui` | 声明式弹窗入口，最多 8 个，见第八节 |

所有路径均为包内相对路径，不能包含 `..`、反斜杠、协议头或绝对路径。

### 权限

| 权限 | 授予后可以 |
|---|---|
| `network` | 调用 `http.request`，以及返回 http(s) URL |
| `clearTextNetwork` | 访问明文 `http://` |
| `localNetwork` | 访问内网/环回地址；未授予时这类地址在 DNS 解析后被拒绝 |
| `credentials` | 读写加密凭据库；`login` 能力强制要求 |
| `webAuth` | 提供网页登录方式，由宿主打开系统 WebView |
| `clipboard` | 写入系统剪贴板 |
| `openUrl` | 请求宿主用外部浏览器打开链接 |
| `playbackRead` | 读取当前播放状态 |
| `playbackControl` | 播放、暂停、跳转、切歌 |
| `queueWrite` | 整体替换播放队列 |
| `notifications` | 显示宿主的 Toast/Snackbar |
| `customUi` | 贡献声明式弹窗入口 |
| `backgroundTimers` | 导出 `backgroundTick`，约每秒被调用一次 |

安装时这些权限会原样列出供用户确认。

---

## 三、媒体 ID

插件只处理服务自身的原生 ID，例如 `2668056312`。跨插件唯一的规范 ID 由宿主生成：

```text
<provider>:<kind>:<百分号编码的原生 ID>
```

`kind` 为 `song`、`album`、`artist`、`playlist`、`user` 之一。原生 ID 上限 2048 字节，
不能包含控制字符。

插件只会收到属于自己的原生 ID，且不应构造其他 provider 的规范 ID。队列、缓存、歌单
上下文和界面跳转全部基于规范 ID，构造非法值会导致宿主抛出异常。

---

## 四、能力与 handler

每个 capability 对应同名 handler，按用途分组如下。

### 搜索

| handler | 入参 | 返回 |
|---|---|---|
| `searchSongs` | `{query, cursor, limit}`，limit 1–100 | `{items: Song[], nextCursor}`，items ≤200 |
| `searchAlbums` | 同上 | `{items: Album[], nextCursor}` |
| `searchArtists` | 同上 | `{items: Artist[], nextCursor}` |
| `hotSearch` | `{}` | 字符串数组，取前 50 条 |

`cursor` 对宿主不透明，可以是 offset、页码或服务端 token，≤8192 字符。没有下一页时
返回空串。

### 详情

| handler | 入参 | 返回 |
|---|---|---|
| `songDetails` | `{ids: string[]}`，≤500 | `Song[]` |
| `playlistDetails` | `{id}` | `Playlist`，`songs` ≤20000 |
| `albumDetails` | `{id}` | `Album`，`songs` ≤5000 |
| `artistDetails` | `{id}` | `Artist`，`songs`/`albums` 各 ≤1000 |

### 首页与个人内容

| handler | 入参 | 返回 |
|---|---|---|
| `home` | `{limit}` | `{songs, playlists, sections}` |
| `home` | `{operation: "recommendSongs"}` | `Song[]`，为数组而非对象 |
| `recent` | `{limit}`，limit 1–500 | `Song[]` |
| `userPlaylists` | `{limit}`，limit 1–500 | `Playlist[]` |

`home` 一个 handler 服务两种调用，通过 `operation` 区分：无 `operation` 时返回首页
数据；`operation` 为 `recommendSongs` 时返回「每日推荐」一类的歌曲列表。

首页三部分的用途：

- `songs`（≤100）——推荐歌曲。
- `playlists`（≤100）——推荐歌单栅格。`limit` 只约束这一部分，取值来自用户在设置中的
  「首页歌单数量」。
- `sections`（≤6 组，每组 ≤30 个歌单）——绘制在栅格上方的分组，结构为
  `{title, playlists}`。适用于音源本身即有分区名称的列表，例如网易云的雷达歌单、
  专属场景歌单。空分组会被丢弃。

### 播放与歌词

| handler | 入参 | 返回 |
|---|---|---|
| `resolveStream` | `{id, quality}` | 见下 |
| `lyrics` | `{id}` | `{assets: [...]}` |
| `scrobble` | `{id, playedMs, durationMs, completed}` | 宿主忽略返回值 |
| `heartRecommendation` | `{songId, playlistId, limit}` | `Song[]` |

`resolveStream` 返回：

```js
{
  url: "https://...",          // 必填，必须位于声明的域名内
  headers: {"Referer": "..."}, // 可选，≤64 条，值 ≤8192 字符且不含换行
  mimeType: "audio/mpeg",      // 可选
  expiresAtMs: 1700000000000,  // 可选，过期后宿主重新解析
  trial: false,                // 试听片段
  cacheable: true,             // 默认 true，一次性 URL 应设为 false
  renditionId: "1234"          // 可选，实际音轨与请求不一致时使用
}
```

`Host`、`Content-Length`、`Connection` 三个请求头会被丢弃。

`lyrics` 的每个 asset：`format` 为 `lrc`/`yrc`/`ttml`，`role` 为
`original`/`translation`/`romanization`（默认 `original`），`text` 为内容。
最多 12 个 asset，单个 ≤4 MiB。

### 账号与收藏

| handler | 入参 | 返回 |
|---|---|---|
| `account` | `{}` | `Account` |
| `login` | `{operation, ...}` | 见第六节 |
| `like` | `{operation: "list"}` | 原生歌曲 ID 数组，≤100000 |
| `like` | `{operation: "set", id, liked}` | `true` 或 `{success: true}` |
| `playlistMutation` | `{operation, playlistId, songIds, name}` | 同上 |
| `share` | `{id, kind}` | 分享链接字符串 |

`playlistMutation` 的 `operation` 取值：`add`、`remove`、`subscribe`、`unsubscribe`、
`delete`、`create`。`create` 没有 `playlistId`，入参为
`{operation:"create", name, private}`，返回 `{id: "新歌单原生ID"}` 或 ID 字符串。
其余操作的 `songIds` ≤1000。

`matchSong` 在能力枚举中保留，当前宿主不会调用。

---

## 五、数据结构

宿主对每个字段做类型和长度校验，越界会使整个响应失败。缺失的可选字段取默认值。

### Song

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string/number | **必填**，原生 ID |
| `title` | string | **必填**，≤4096 |
| `durationMs` | number | 0 – 31 天 |
| `artworkUrl` | string | 封面原图，须位于授权域名内，否则被清空 |
| `artworkThumbUrl` | string | 列表行使用的小图，见下 |
| `artists` | array | ≤64 个 `{id, name}`，无 `name` 的条目被丢弃 |
| `album` | object | `{id, name}`，`name` 为空时整个字段不设置 |
| `isrc` | string | 可选 |
| `playable` | boolean | 默认 `true` |
| `trial` | boolean | 仅有试听 |
| `restricted` | boolean | 受区域或版权限制 |

`artworkThumbUrl` 用于列表行。歌曲行高约 48dp，而音源提供的封面通常在一千像素量级；
没有该字段时，滚动长歌单需要为每一行下载并完整解码一张原图，造成掉帧与频繁 GC。
若图床支持缩放参数（网易云 `?param=140y140`、QQ `T002R300x300`），应填写此字段；
未填写时回退到 `artworkUrl`。该字段与 `artworkUrl` 使用同一套域名校验。需要宿主
1.5.1 及以上。

### Playlist

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string/number | **必填** |
| `name` | string | **必填**，≤4096 |
| `description` | string | ≤1 MiB |
| `artworkUrl` / `artworkThumbUrl` | string | 同上 |
| `trackCount` | number | 曲目数 |
| `playCount` | number | 播放量；无曲目数时界面改为显示该值 |
| `subscribed` / `owned` | boolean | 是否已收藏 / 是否为自建 |
| `mutable` / `deletable` | boolean | 默认跟随 `owned`，可显式覆盖 |
| `owner` | object | `{id, name}` |
| `songs` | array | ≤20000 |

### Album / Artist

Album：`id`、`name`（必填）、`artworkUrl`、`publishTimeMs`、`description`、
`trackCount`（≤100 万）、`artists`（≤64）、`songs`（≤5000）。

Artist：`id`、`name`（必填）、`artworkUrl`、`description`、`albumCount`、
`songCount`、`songs`（≤1000）、`albums`（≤1000）。

### Account

`loggedIn`、`id`、`displayName`、`avatarUrl`、`membershipTier`（0–1000）、
`level`（0–100000）、`signature`。头像 URL 同样需位于授权域名内。

---

## 六、登录

登录界面由宿主提供，流程由插件定义。`login` 一个 handler 处理五种 `operation`：

| operation | 入参 | 返回 |
|---|---|---|
| `methods` | `{}` | 登录方式数组，≤8 |
| `begin` | `{methodId}` | Challenge |
| `poll` | `{challengeId}` | Challenge |
| `submit` | `{methodId, credential}` | Challenge |
| `logout` | `{}` | `true` |

登录方式结构：

```js
{
  id: "qr",                    // [a-z][a-z0-9._-]{0,63}
  type: "qr",                  // qr | web | credential
  label: "扫码登录",
  instructions: "用手机 App 扫描二维码",
  // type 为 web 时必填，必须是 HTTPS 且位于授权域名内：
  webUrl: "https://example.com/login",
  cookieUrl: "https://example.com",
  credentialCookieName: "SESSION",
  // type 为 credential 时可选：
  credentialLabel: "粘贴 Cookie"
}
```

`web` 方式需要 `webAuth` 权限。宿主打开系统 WebView，用户登录后仅将
`credentialCookieName` 指定的那一条 cookie 回传给插件，其余不予返回。QPlayer 不解析
任何厂商的 cookie 语义。

Challenge 是流程的一次状态快照：

```js
{
  id: "challenge-1",
  methodId: "qr",
  status: "waiting",           // waiting | scanned | success | expired | failed
  message: "等待扫码",
  qrContent: "https://...",    // 由宿主渲染二维码
  expiresAtMs: 0,
  account: {...}               // success 时可一并返回，省去一次 account 调用
}
```

凭据由插件通过 `credentials.put` 保存，`logout` 时应删除对应的 key。凭据以 AES-GCM
加密并按插件命名空间隔离，QPlayer 不解析其内容。

---

## 七、`qplayer.call`

所有调用均为异步，返回 Promise。

| 方法 | 权限 | 说明 |
|---|---|---|
| `storage.get/put/delete` | — | 插件私有存储，key 为 `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`，单值 ≤1 MiB |
| `credentials.get/put/delete` | `credentials` | 加密存储，按插件与 key 隔离 |
| `http.request` | `network` | 见下 |
| `crypto.digest/random/aes/hmac/modPow/x25519` | — | 见下 |
| `compression.gunzip` | — | `{data, dataEncoding, output}` |
| `playback.read` | `playbackRead` | 当前播放快照 |
| `playback.play/pause/seek/select/next/blockAutoAdvance` | `playbackControl` | 与音源无关的播放控制 |
| `queue.replace` | `queueWrite` | `{songs, currentSongId, positionMs, playing}` |
| `notifications.toast` | `notifications` | `{message}`，≤500 字符 |
| `clipboard.write` | `clipboard` | `{text}`，≤16 KiB |

### http.request

```js
qplayer.call("http.request", {
  url: "https://api.example.com/x",
  method: "POST",
  headers: {"Content-Type": "application/x-www-form-urlencoded"},
  body: "a=1&b=2",
  timeoutMs: 10000,        // 1000–30000
  includeBase64: false     // 需要二进制内容时置 true
})
// → {status, finalUrl, body, headers, setCookies, bodyBase64?}
```

请求前后各有一次检查：URL 必须命中 `networkDomains`，方法必须在 `networkMethods` 内，
DNS 解析到内网或环回地址会被拒绝（除非声明 `localNetwork`），重定向最多 5 次且每一跳
都重新校验。303 以及 POST 上的 301/302 按规范降级为 GET，此时 `GET` 也必须在声明的
方法内。请求体与响应体各自 ≤16 MiB。`Set-Cookie` 另行整理为 `setCookies` 数组，
因为 Java 的 header map 会合并同名头。

### crypto

宿主提供一组固定原语，覆盖常见音源的签名与加解密需求，不支持任意算法：

- `crypto.digest` — `{algorithm: "SHA-256"|"SHA-1"|"MD5", data, dataEncoding, output}`
- `crypto.random` — `{length: 1..1024, output}`
- `crypto.aes` — `{transformation: "AES/CBC/PKCS5Padding"|"AES/ECB/PKCS5Padding"|"AES/GCM/NoPadding", operation: "encrypt"|"decrypt", key, iv, aad, data}`
- `crypto.hmac` — `{algorithm: "HmacSHA256"|"HmacSHA1", key, data}`
- `crypto.modPow` — `{baseHex, exponentHex, modulusHex, width}`，用于 RSA 运算
- `crypto.x25519` — `{scalar, point}`，各 32 字节

编码约定：数据类参数（`data`）默认按 `utf8` 解释，密钥类参数（`key`、`iv`、`aad`、
`scalar`）默认按 `base64`；均可通过 `<参数名>Encoding` 指定为 `utf8`/`base64`/`hex`。
输出编码由 `output` 指定，默认 `base64`。

### 播放状态

`playback.read` 返回：

```js
{
  currentSongId: "123",     // 当前歌曲不属于该插件时为空串
  queueSongIds: ["1","2"],  // 队列中混有其他音源时为空数组
  positionMs: 0, durationMs: 0,
  playing: true,
  transitioning: false,     // 宿主正在切歌
  seekRevision: 0,          // 变化表示用户拖动过进度
  endRevision: 0            // 变化表示有一首自然播放结束
}
```

这组接口与音源无关，宿主不需要了解插件用它实现何种功能。

---

## 八、声明式弹窗

插件不提供 QML。插件在清单中声明入口并返回结构化描述，由 QPlayer 用自身的 Material 3
组件渲染。因此插件弹窗自动跟随应用主题、深浅色与字号，插件无需编写样式；代价是可用
节点仅限下表所列。

```json
{"id": "preferences", "placement": "settings", "label": "插件设置", "icon": "tune"}
```

`placement: "settings"` 出现在该插件的设置页；`placement: "playerAction"` 出现在手机
顶栏和平板/桌面的导航栏。QPlayer 不了解入口对应的功能，只负责放置入口。

入口被打开时，宿主调用 `handlers["ui.<入口id>"]`，参数为
`{action, payload: {inputs}}`：

- 打开时 `action` 为 `open`
- 描述中的 `refreshMs`（0，或 500–60000）使宿主定期以 `refresh` 再次调用
- 用户点击按钮或拨动开关时，`action` 为该控件自身的 `id`
- `inputs` 为当前所有输入框与开关的值（字符串 / 布尔）

每次返回的描述整体替换上一份。状态由插件维护，渲染由宿主负责。

```js
return {
  title: "一起听", subtitle: "网易云音乐", icon: "group", refreshMs: 1500,
  body: [
    {type: "text", style: "title", center: true, text: "2 人正在一起听"},
    {type: "switch", id: "unlock", label: "音源解锁", desc: "灰色歌曲尝试其他来源", checked: true},
    {type: "input", id: "invitation", placeholder: "邀请链接或房间 ID"},
    {type: "row", items: [
      {type: "button", id: "create", label: "创建房间", style: "filled"},
      {type: "button", id: "join", label: "加入房间", style: "outlined"}
    ]}
  ]
};
```

| 节点 | 字段 |
|---|---|
| `text` | `text`（≤500）、`style`（`title`/`body`/`caption`）、`center` |
| `error` | `text`（≤300） |
| `input` | `id`、`placeholder`（≤60）、`value`（≤2048）、`secret` |
| `switch` | `id`、`label`（≤120）、`desc`（≤500）、`checked`、`enabled` |
| `button` | `id`、`label`（≤24）、`style`（`filled`/`outlined`/`text`）、`enabled`、`destructive` |
| `row` | `items`：1–3 个按钮，不可嵌套 |
| `spacer` | `height` 0–48 |

`title` ≤60，`subtitle` ≤120，`body` 最多 10 个节点。id 形如
`[a-z][a-z0-9._-]{0,63}`，`input` 与 `switch` 共用同一 id 空间且不能重名。

`switch` 既是输入也是动作：拨动时以自身 id 触发一次调用，新状态以布尔值出现在
`payload.inputs[id]` 中。开关类状态应使用该节点，宿主的渲染结果与自身设置项一致。

描述中没有颜色、图片、富文本和自由布局：插件描述对话框而不绘制对话框，因此无法模仿
未被授予的宿主界面。任何不符合 schema 的字段都会使整份描述失败，而不是被忽略，从而
不存在通过畸形结构试探渲染行为的空间。

### 后台 tick

声明 `backgroundTimers` 后可以导出 `backgroundTick`。宿主约每秒在插件 actor 上调用
一次，同一插件的 tick 不会重入，插件被停用或卸载后立即停止。房间协议、进度同步、
轮询等逻辑放在此处，并通过上述通用播放接口影响宿主。

---

## 九、打包、签名与发布

```text
plugin.json
src/main.js
META-INF/qplayer-files.json     # 每个文件的 SHA-256
META-INF/qplayer.sig            # 对上述文件原始字节的 P-256 ECDSA/SHA-256 签名(Base64 DER)
```

除哈希清单自身和签名外，包内每个文件都必须出现在哈希清单中。安装后每次启用都会重新
校验哈希，事后加入或修改的文件不会被执行。

未签名的包可以手动导入用于开发，QPlayer 会强制显示一次代码执行警告。正式分发需使用
发布者私钥签名：

```bash
QPLAYER_PLUGIN_SIGNING_KEY=/secure/path/publisher-private.pem ./scripts/package.sh
```

QPlayer 内置一份音源仓库列表，每条固定了 GitHub `owner/repo` 与发布者公钥。可安装
版本取自该仓库的 latest release，因此发布需满足：tag 为 `v<plugin.json 的 version>`、
release 中恰好挂载一个 `.qplug`、且不是草稿或预发布。满足后插件可以按自身节奏发版，
不需要 QPlayer 同步发版。

发布者密钥一旦被固定就无法更换：公钥编译在 QPlayer 二进制中，更换密钥会使所有已发布
的 QPlayer 无法安装该插件，直到 QPlayer 发布新版本。

---

## 十、限额速查

| 项目 | 上限 |
|---|---|
| 单次 handler 调用 | 90 秒 |
| 单个 JS 模块 | 4 MiB |
| 返回值 | 深度 32 / 节点 50 万 / 字符串合计 24 MiB |
| `http.request` 请求体、响应体 | 各 16 MiB |
| HTTP 超时 | 1–30 秒，默认 10 秒 |
| 重定向 | 5 次 |
| `storage` 单值 | 1 MiB |
| 原生 ID | 2048 字节 |
| 标题/名称类文本 | 4096 字符 |
| 简介类文本 | 1 MiB |
| 分页游标 | 8192 字符 |
| 搜索结果 | 每页 200 条 |
| 歌单曲目 | 20000 |
| 歌词 | 12 个 asset，每个 4 MiB |
| 弹窗 | 10 个节点 |
| UI 入口 | 8 个 |

---

## 十一、常见问题

- 插件返回的 URL 同样受网络授权约束。封面、播放地址、登录页、头像都必须位于
  `networkDomains` 内，否则封面被清空、播放地址报错。CDN 域名变更时需同步更新清单。
- 一次性播放地址应设置 `cacheable: false`，否则宿主会缓存已失效的 URL。
- `nextCursor` 不应返回 `"null"` 等非空占位值，任何非空字符串都表示仍有下一页。
- 没有名称的歌手或专辑条目会被丢弃而不是导致响应失败。真实歌单中存在这类数据
  （云盘上传、下架艺人），丢弃单个条目可以让整个歌单仍然可用。
- `limit` 既是建议也是上限。宿主按用户设置传值，并在解析时再次截断，返回超量数据不会
  被使用。
- handler 内应避免 CPU 密集循环。90 秒的超时覆盖整个调用，包括等待网络的时间。

调试方式：将原始响应通过 `storage.put` 保存后查看（注意 1 MiB 上限），或在关键分支上
调用 `notifications.toast` 输出信息。插件的 `console` 输出不会进入宿主日志。
