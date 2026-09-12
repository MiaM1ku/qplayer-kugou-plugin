# QPlayer plugin ABI 1.0

<p><a href="ABI.md">简体中文</a> · <b>English</b></p>

This document describes the complete contract between QPlayer and a music source
plugin: the arguments a handler receives, the structures it must return, and the
inputs the host rejects.

QPlayer itself contains no online music source. Search, playlists, stream URLs,
lyrics and login all come from a `.qplug` package the user installs. The host does
three things: run the plugin in an isolated environment, validate every field it
returns, and render the result. The limits below follow from the host having to
treat plugin code as unreviewed third-party code.

---

## 1. Runtime

A plugin is CommonJS JavaScript running on the embedded Rhino engine, one realm per
plugin. It has no access to Java classes, `Packages`, the filesystem, other plugins'
data, or QPlayer's QML scene. The only external interface is the global `qplayer`
object.

Each plugin has one actor thread and handlers run serially, so there is no
concurrency to manage. A single call is interrupted after **90 seconds**.

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

A handler may return a value or a Promise. `require()` loads only relative `.js`
files inside the verified package, 4 MiB per module.

Every capability declared in the manifest must be implemented. At startup the host
checks `handlers[capability]` one by one and refuses activation if any is missing,
so the UI never shows an entry that does nothing.

---

## 2. `plugin.json`

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

| Field | Notes |
|---|---|
| `schemaVersion` | always `1` |
| `id` | plugin/source id, also the prefix of every media id. `local` is reserved |
| `name` | display name, ≤80 chars |
| `version` | plugin version; the release tag must match it |
| `apiVersion` | currently `1.0` |
| `minHostVersion` | optional; older QPlayer builds refuse to install |
| `entry` | entry script, package-relative |
| `capabilities` | see section 4; declare only what is implemented |
| `permissions` | see below; declare only what is used |
| `networkDomains` | exact host or `*.example.com`; requires the `network` permission |
| `networkMethods` | subset of `GET`/`POST`/`PUT`/`PATCH`/`DELETE`/`HEAD`; empty means `["GET","POST"]` |
| `ui` | declarative dialog entries, at most 8, see section 8 |

All paths are package-relative and may not contain `..`, backslashes, schemes or
absolute segments.

### Permissions

| Permission | Grants |
|---|---|
| `network` | calling `http.request` and returning http(s) URLs |
| `clearTextNetwork` | plain `http://` access |
| `localNetwork` | private/loopback addresses, otherwise refused after DNS resolution |
| `credentials` | the encrypted vault; required by `login` |
| `webAuth` | web login through the platform system WebView |
| `clipboard` | writing the system clipboard |
| `openUrl` | asking the host to open a link in an external browser |
| `playbackRead` | reading the current playback state |
| `playbackControl` | play, pause, seek, skip |
| `queueWrite` | replacing the playback queue |
| `notifications` | host toast/snackbar |
| `customUi` | declarative dialog entries |
| `backgroundTimers` | exporting `backgroundTick`, called about once a second |

These permissions are listed verbatim for the user to confirm at install time.

---

## 3. Media identity

A plugin only handles the service's own native ids, e.g. `2668056312`. The host
produces the globally unique form:

```text
<provider>:<kind>:<percent-encoded native id>
```

`kind` is one of `song`, `album`, `artist`, `playlist`, `user`. Native ids are
limited to 2048 bytes and may not contain control characters.

A plugin only receives ids that belong to it and must not construct another
provider's canonical id. Queues, caches, playlist context and navigation are all
based on canonical ids, and an invalid one causes the host to throw.

---

## 4. Capabilities and handlers

Each capability maps to a same-named handler, grouped here by purpose.

### Search

| handler | arguments | result |
|---|---|---|
| `searchSongs` | `{query, cursor, limit}`, limit 1–100 | `{items: Song[], nextCursor}`, ≤200 items |
| `searchAlbums` | same | `{items: Album[], nextCursor}` |
| `searchArtists` | same | `{items: Artist[], nextCursor}` |
| `hotSearch` | `{}` | array of strings, first 50 kept |

The cursor is opaque to the host: an offset, a page number or a server token,
≤8192 chars. Return an empty string when there is no next page.

### Details

| handler | arguments | result |
|---|---|---|
| `songDetails` | `{ids: string[]}`, ≤500 | `Song[]` |
| `playlistDetails` | `{id}` | `Playlist`, `songs` ≤20000 |
| `albumDetails` | `{id}` | `Album`, `songs` ≤5000 |
| `artistDetails` | `{id}` | `Artist`, `songs`/`albums` ≤1000 each |

### Home and personal content

| handler | arguments | result |
|---|---|---|
| `home` | `{limit}` | `{songs, playlists, sections}` |
| `home` | `{operation: "recommendSongs"}` | `Song[]`, an array rather than an object |
| `recent` | `{limit}`, 1–500 | `Song[]` |
| `userPlaylists` | `{limit}`, 1–500 | `Playlist[]` |

One handler serves two calls, distinguished by `operation`: without it the host
requests home content; with `operation` set to `recommendSongs` it requests a daily
mix style song list.

The three parts of `home`:

- `songs` (≤100) — recommended tracks.
- `playlists` (≤100) — the recommendation grid. `limit` bounds only this list and
  comes from the user's home-page setting.
- `sections` (≤6 groups of ≤30 playlists) — titled groups drawn above the grid,
  shaped `{title, playlists}`. Intended for lists the source itself names as a
  section, such as NetEase's radar or scenario playlists. Empty groups are dropped.

### Playback and lyrics

| handler | arguments | result |
|---|---|---|
| `resolveStream` | `{id, quality}` | see below |
| `lyrics` | `{id}` | `{assets: [...]}` |
| `scrobble` | `{id, playedMs, durationMs, completed}` | ignored by the host |
| `heartRecommendation` | `{songId, playlistId, limit}` | `Song[]` |

`resolveStream` returns:

```js
{
  url: "https://...",          // required, must be inside the granted domains
  headers: {"Referer": "..."}, // optional, ≤64, values ≤8192 chars, no newlines
  mimeType: "audio/mpeg",      // optional
  expiresAtMs: 1700000000000,  // optional; the host re-resolves afterwards
  trial: false,                // preview clip
  cacheable: true,             // default true; set false for one-shot URLs
  renditionId: "1234"          // optional, when the served track differs
}
```

The `Host`, `Content-Length` and `Connection` request headers are dropped.

Each lyric asset: `format` is `lrc`/`yrc`/`ttml`, `role` is
`original`/`translation`/`romanization` (default `original`), `text` is the content.
At most 12 assets, 4 MiB each.

### Account and library

| handler | arguments | result |
|---|---|---|
| `account` | `{}` | `Account` |
| `login` | `{operation, ...}` | see section 6 |
| `like` | `{operation: "list"}` | native song ids, ≤100000 |
| `like` | `{operation: "set", id, liked}` | `true` or `{success: true}` |
| `playlistMutation` | `{operation, playlistId, songIds, name}` | same |
| `share` | `{id, kind}` | a share URL string |

`playlistMutation` operations: `add`, `remove`, `subscribe`, `unsubscribe`,
`delete`, `create`. `create` carries no `playlistId`; it receives
`{operation:"create", name, private}` and returns `{id: "<native id>"}` or the id
string. Other operations carry ≤1000 `songIds`.

`matchSong` remains in the capability enum; the current host does not invoke it.

---

## 5. Data shapes

Every field is type- and length-checked; a value out of range fails the entire
response. Missing optional fields take their defaults.

### Song

| Field | Type | Notes |
|---|---|---|
| `id` | string/number | **required**, native id |
| `title` | string | **required**, ≤4096 |
| `durationMs` | number | 0 – 31 days |
| `artworkUrl` | string | full-size cover; cleared if outside the grant |
| `artworkThumbUrl` | string | list-row sized cover, see below |
| `artists` | array | ≤64 `{id, name}`; entries without a `name` are dropped |
| `album` | object | `{id, name}`; left unset when `name` is empty |
| `isrc` | string | optional |
| `playable` | boolean | default `true` |
| `trial` | boolean | preview only |
| `restricted` | boolean | region or licensing restricted |

`artworkThumbUrl` is used by list rows. A song row is about 48dp tall while source
covers are typically around a thousand pixels square; without this field, scrolling
a long playlist downloads and fully decodes one full-size image per row, causing
dropped frames and frequent GC. If the CDN supports a resize parameter (NetEase's
`?param=140y140`, QQ's `T002R300x300`), provide it; otherwise the host falls back to
`artworkUrl`. The same domain check applies. Requires host 1.5.1 or later.

### Playlist

| Field | Type | Notes |
|---|---|---|
| `id` | string/number | **required** |
| `name` | string | **required**, ≤4096 |
| `description` | string | ≤1 MiB |
| `artworkUrl` / `artworkThumbUrl` | string | as above |
| `trackCount` | number | track count |
| `playCount` | number | play count; displayed instead when there is no track count |
| `subscribed` / `owned` | boolean | followed / created by the user |
| `mutable` / `deletable` | boolean | follow `owned` unless set explicitly |
| `owner` | object | `{id, name}` |
| `songs` | array | ≤20000 |

### Album / Artist

Album: `id`, `name` (required), `artworkUrl`, `publishTimeMs`, `description`,
`trackCount` (≤1,000,000), `artists` (≤64), `songs` (≤5000).

Artist: `id`, `name` (required), `artworkUrl`, `description`, `albumCount`,
`songCount`, `songs` (≤1000), `albums` (≤1000).

### Account

`loggedIn`, `id`, `displayName`, `avatarUrl`, `membershipTier` (0–1000), `level`
(0–100000), `signature`. The avatar URL must also be inside the granted domains.

---

## 6. Login

The login UI belongs to the host; the flow is defined by the plugin. One `login`
handler serves five operations:

| operation | arguments | result |
|---|---|---|
| `methods` | `{}` | array of login methods, ≤8 |
| `begin` | `{methodId}` | challenge |
| `poll` | `{challengeId}` | challenge |
| `submit` | `{methodId, credential}` | challenge |
| `logout` | `{}` | `true` |

A login method:

```js
{
  id: "qr",                    // [a-z][a-z0-9._-]{0,63}
  type: "qr",                  // qr | web | credential
  label: "Scan to sign in",
  instructions: "Scan the code with the mobile app",
  // required for web, must be HTTPS and inside the grant:
  webUrl: "https://example.com/login",
  cookieUrl: "https://example.com",
  credentialCookieName: "SESSION",
  // optional for credential:
  credentialLabel: "Paste cookie"
}
```

`web` requires the `webAuth` permission. The host opens the platform WebView and
returns only the cookie named by `credentialCookieName`; nothing else is passed
back. QPlayer does not interpret any vendor's cookie semantics.

A challenge is one snapshot of the flow:

```js
{
  id: "challenge-1",
  methodId: "qr",
  status: "waiting",           // waiting | scanned | success | expired | failed
  message: "Waiting for scan",
  qrContent: "https://...",    // the host renders the QR code
  expiresAtMs: 0,
  account: {...}               // may be included on success to save a call
}
```

The plugin persists credentials with `credentials.put` and should delete those keys
on `logout`. Credentials are AES-GCM encrypted and namespaced per plugin; QPlayer
does not parse their contents.

---

## 7. `qplayer.call`

All calls are asynchronous and return a Promise.

| Method | Permission | Notes |
|---|---|---|
| `storage.get/put/delete` | — | plugin-private, key `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`, ≤1 MiB per value |
| `credentials.get/put/delete` | `credentials` | encrypted, isolated per plugin and key |
| `http.request` | `network` | see below |
| `crypto.digest/random/aes/hmac/modPow/x25519` | — | see below |
| `compression.gunzip` | — | `{data, dataEncoding, output}` |
| `playback.read` | `playbackRead` | playback snapshot |
| `playback.play/pause/seek/select/next/blockAutoAdvance` | `playbackControl` | source-neutral playback control |
| `queue.replace` | `queueWrite` | `{songs, currentSongId, positionMs, playing}` |
| `notifications.toast` | `notifications` | `{message}`, ≤500 chars |
| `clipboard.write` | `clipboard` | `{text}`, ≤16 KiB |

### http.request

```js
qplayer.call("http.request", {
  url: "https://api.example.com/x",
  method: "POST",
  headers: {"Content-Type": "application/x-www-form-urlencoded"},
  body: "a=1&b=2",
  timeoutMs: 10000,        // 1000–30000
  includeBase64: false     // true when the raw bytes are needed
})
// → {status, finalUrl, body, headers, setCookies, bodyBase64?}
```

There is a check on both ends: the URL must match `networkDomains`, the method must
be declared, a host resolving to a private or loopback address is refused unless
`localNetwork` is granted, and redirects — 5 at most — are re-checked on every hop.
A 303, or a 301/302 on POST, downgrades to GET per spec, so `GET` must be declared
as well. Request and response bodies are capped at 16 MiB each. `Set-Cookie` is also
returned separately as `setCookies`, because Java's header map folds duplicates.

### crypto

The host exposes a fixed set of primitives covering the signing and decryption
common sources require, rather than arbitrary algorithms:

- `crypto.digest` — `{algorithm: "SHA-256"|"SHA-1"|"MD5", data, dataEncoding, output}`
- `crypto.random` — `{length: 1..1024, output}`
- `crypto.aes` — `{transformation: "AES/CBC/PKCS5Padding"|"AES/ECB/PKCS5Padding"|"AES/GCM/NoPadding", operation: "encrypt"|"decrypt", key, iv, aad, data}`
- `crypto.hmac` — `{algorithm: "HmacSHA256"|"HmacSHA1", key, data}`
- `crypto.modPow` — `{baseHex, exponentHex, modulusHex, width}`, for RSA steps
- `crypto.x25519` — `{scalar, point}`, 32 bytes each

Encoding rules: data arguments (`data`) default to `utf8`, key material (`key`,
`iv`, `aad`, `scalar`) defaults to `base64`; either can be overridden with
`<name>Encoding` set to `utf8`/`base64`/`hex`. Output encoding is `output`,
default `base64`.

### Playback state

`playback.read` returns:

```js
{
  currentSongId: "123",     // empty when the current track is not the plugin's
  queueSongIds: ["1","2"],  // empty array when the queue mixes other sources
  positionMs: 0, durationMs: 0,
  playing: true,
  transitioning: false,     // the host is switching tracks
  seekRevision: 0,          // changes when the user seeks
  endRevision: 0            // changes when a track ends naturally
}
```

This surface is source-neutral; the host does not need to know what feature the
plugin builds on top of it.

---

## 8. Declarative dialogs

A plugin contributes no QML. It declares an entry in the manifest and returns a
structured description, which QPlayer renders with its own Material 3 components.
A plugin dialog therefore follows the app's theme, dark mode and text scale without
any styling code, at the cost of being limited to the nodes listed below.

```json
{"id": "preferences", "placement": "settings", "label": "Preferences", "icon": "tune"}
```

`placement: "settings"` appears on that plugin's settings page;
`placement: "playerAction"` appears in the phone top bar and the tablet/desktop
navigation rail. QPlayer does not know what the entry does; it only places it.

Opening the entry invokes `handlers["ui.<entry id>"]` with
`{action, payload: {inputs}}`:

- `action` is `open` when the dialog opens
- `refreshMs` in the description (0, or 500–60000) makes the host re-invoke it with
  `refresh`
- pressing a button or flipping a switch sends that control's own `id`
- `inputs` maps every input and switch id to its current value (string / boolean)

Each reply replaces the previous description. The plugin owns the state; the host
owns the rendering.

```js
return {
  title: "Listen Together", subtitle: "NetEase Cloud Music", icon: "group", refreshMs: 1500,
  body: [
    {type: "text", style: "title", center: true, text: "2 listeners"},
    {type: "switch", id: "unlock", label: "Source unlock", desc: "Try other sources for greyed tracks", checked: true},
    {type: "input", id: "invitation", placeholder: "Invite link or room id"},
    {type: "row", items: [
      {type: "button", id: "create", label: "Create", style: "filled"},
      {type: "button", id: "join", label: "Join", style: "outlined"}
    ]}
  ]
};
```

| Node | Fields |
|---|---|
| `text` | `text` (≤500), `style` (`title`/`body`/`caption`), `center` |
| `error` | `text` (≤300) |
| `input` | `id`, `placeholder` (≤60), `value` (≤2048), `secret` |
| `switch` | `id`, `label` (≤120), `desc` (≤500), `checked`, `enabled` |
| `button` | `id`, `label` (≤24), `style` (`filled`/`outlined`/`text`), `enabled`, `destructive` |
| `row` | `items`: 1–3 buttons, no nesting |
| `spacer` | `height` 0–48 |

`title` ≤60, `subtitle` ≤120, at most 10 body nodes. Ids match
`[a-z][a-z0-9._-]{0,63}`; inputs and switches share one id space and must be unique.

A `switch` is both input and action: flipping it submits its own id, and its new
state arrives as a boolean in `payload.inputs[id]`. Use it for on/off state; the
host renders it identically to its own settings rows.

The schema has no colors, images, rich text or free-form geometry: a plugin
describes a dialog rather than painting one, so it cannot imitate host chrome it was
not given. Anything off-schema fails the entire description instead of being
dropped, which leaves no way to probe rendering behaviour with malformed shapes.

### Background tick

A plugin declaring `backgroundTimers` may export `backgroundTick`. The host calls it
about once a second on the plugin actor, never overlaps two ticks for the same
plugin, and stops immediately when the plugin is disabled or removed. Room
protocols, sync policy and polling belong here and reach the host through the
generic playback calls above.

---

## 9. Packaging, signing, releasing

```text
plugin.json
src/main.js
META-INF/qplayer-files.json     # SHA-256 of every file
META-INF/qplayer.sig            # P-256 ECDSA/SHA-256 over that file's exact bytes (Base64 DER)
```

Every file except the hash manifest itself and the signature must appear in that
hash list. Installed files are re-hashed before every activation, so files added or
modified afterwards are not executed.

Unsigned packages can be imported manually for development, and QPlayer always shows
a mandatory code-execution warning for them. Public distribution requires signing
with the publisher key:

```bash
QPLAYER_PLUGIN_SIGNING_KEY=/secure/path/publisher-private.pem ./scripts/package.sh
```

QPlayer carries a built-in list of source repositories, each pinned to a GitHub
`owner/repo` and a publisher public key. The offered version comes from that
repository's latest release, so a release must be tagged
`v<version from plugin.json>`, attach exactly one `.qplug`, and not be a draft or
pre-release. When these conditions are met, a plugin ships updates on its own
schedule without a QPlayer release.

A pinned publisher key cannot be rotated: the public key is compiled into the
QPlayer binary, and changing it prevents every already-released QPlayer from
installing the plugin until QPlayer itself ships a new version.

---

## 10. Limits at a glance

| Item | Limit |
|---|---|
| One handler call | 90 s |
| One JS module | 4 MiB |
| Returned value | depth 32 / 500k nodes / 24 MiB of strings |
| `http.request` body, response | 16 MiB each |
| HTTP timeout | 1–30 s, default 10 |
| Redirects | 5 |
| `storage` value | 1 MiB |
| Native id | 2048 bytes |
| Title/name text | 4096 chars |
| Description text | 1 MiB |
| Pagination cursor | 8192 chars |
| Search results | 200 per page |
| Playlist tracks | 20000 |
| Lyrics | 12 assets, 4 MiB each |
| Dialog | 10 nodes |
| UI entries | 8 |

---

## 11. Common issues

- URLs returned by a plugin are subject to the same network grant. Covers, stream
  URLs, login pages and avatars must all be inside `networkDomains`, or the cover is
  cleared and the stream fails. Update the manifest when a CDN changes.
- One-shot stream URLs should set `cacheable: false`, otherwise the host caches a URL
  that has already expired.
- `nextCursor` should not carry a placeholder such as `"null"`; any non-empty string
  means there is another page.
- Artist or album entries without a name are dropped rather than failing the
  response. Real catalogs contain them (cloud uploads, delisted artists), and
  dropping a single entry keeps the rest of the playlist usable.
- `limit` is both a hint and a cap. The host passes the user's setting and truncates
  again while parsing, so extra items are not used.
- Avoid CPU-bound loops in a handler. The 90-second timeout covers the whole call,
  including time spent waiting on the network.

For debugging: store raw responses with `storage.put` and inspect them later (note
the 1 MiB cap), or call `notifications.toast` on branches under investigation.
Plugin `console` output does not reach the host log.
