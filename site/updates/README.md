# /updates

This directory is the **auto-update feed** served at `https://nodeterm.dev/updates/`.
The app's `electron-updater` reads `latest-mac.yml` from here.

On each release, drop the build artifacts from `dist/` here (overwriting `latest-mac.yml`):

```
latest-mac.yml
nodeterm-<version>-arm64.dmg        (+ .blockmap)
nodeterm-<version>.dmg              (+ .blockmap)   # Intel
nodeterm-<version>-arm64-mac.zip    (+ .blockmap)   # used by auto-update
nodeterm-<version>-mac.zip          (+ .blockmap)
```

These files are intentionally **not** committed to git (they are large binaries); deploy
them straight to the host.
