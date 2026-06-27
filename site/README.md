# nodeterm.dev — landing page

Static landing page for [nodeterm.dev](https://nodeterm.dev). No build step — plain
HTML/CSS/JS. Deploy the contents of this folder to any static host (Netlify, Cloudflare
Pages, GitHub Pages, S3, Nginx, …).

```
site/
  index.html          landing page
  styles.css
  assets/             logo + hero illustration
  announcements.json  → served at /announcements.json (the in-app news feed)
  updates/            → served at /updates/ (the auto-update feed; binaries go here)
```

## How the download buttons work

`index.html` fetches `/updates/latest-mac.yml` on load, reads the version and the `.dmg`
filenames, and points the buttons at the latest build. If the feed isn't reachable yet, the
buttons fall back to the GitHub Releases page. So once you deploy a release to `/updates/`,
the download buttons update themselves — no edit needed.

## Two feeds this site serves

- **`/announcements.json`** — the in-app news banner reads this. Edit it to post news; see
  the schema in [`../docs/announcements.example.json`](../docs/announcements.example.json).
- **`/updates/`** — the app's auto-updater reads `latest-mac.yml` here. Populated per
  release (see [`updates/README.md`](./updates/README.md)).

## Local preview

```bash
cd site && python3 -m http.server 8080   # → http://localhost:8080
```
