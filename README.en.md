# QPlayer Kugou source plugin

<p><a href="README.md">简体中文</a> · <b>English</b></p>

Independent QPlayer source plugin (ABI 1.0). Signing, search and QR login follow
[go-music-dl](https://github.com/guohuiyuan/go-music-dl) / `music-lib`.
Not affiliated with Kugou.

Native song IDs are 32-character audio hashes. Signed-in playlists come from the
cloud list API (`cloudlist:{listid}`), not the public mobile index.
Listen Together is a player action: join a Concept-edition room and follow its
playback. Creating a room requires a real-name-verified Kugou account.

## Build

```bash
./scripts/package.sh
python3 scripts/verify-package.py dist/*.qplug
```
