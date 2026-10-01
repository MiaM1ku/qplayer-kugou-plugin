# QPlayer 酷狗音乐音源插件

<p><b>简体中文</b> · <a href="README.en.md">English</a></p>

QPlayer 的独立音源插件，实现公开的 JavaScript 插件 ABI（apiVersion 1.0）。
解析、签名与扫码登录参考 [go-music-dl](https://github.com/guohuiyuan/go-music-dl) / `music-lib` 的 kugou 实现。

本项目与酷狗音乐没有隶属或合作关系，不分发音频或账号凭据。使用者需自行遵守服务条款与当地法律。

## 功能

| 能力 | 说明 |
|---|---|
| `searchSongs` / `searchAlbums` | 搜索歌曲与专辑 |
| `songDetails` | 按 hash 取详情 |
| `playlistDetails` / `albumDetails` | 歌单、专辑曲目 |
| `home` | 手机端热门歌单 |
| `userPlaylists` | 登录后的用户歌单 |
| `resolveStream` | songinfo v2 → playInfo → tracker |
| `lyrics` | KRC 解密后的逐字 LRC，含翻译/罗马音（若有） |
| `login` / `account` | 扫码（含设备注册）或粘贴 Cookie |

歌曲原生 ID 为 32 位音频 hash。VIP 音质需要有效登录 Cookie。

## 构建

```bash
./scripts/package.sh
python3 scripts/verify-package.py dist/*.qplug
```

完整 ABI 见 [插件模板](https://github.com/TIMER-err/qplayer-plugin-template/blob/main/docs/ABI.md)。
