# Repository Guide

- This is a static, multi-page site: `index.html`, `about.html`, `shop.html`, `music.html`, and `journey.html` load shared root-level `style.css` and `script.js`. Keep navigation and shared behavior consistent across pages.
- `script.js` is included on every page and wires page features by querying their selectors; when adding behavior, keep it safe on pages that do not contain that feature.
- There is no package manifest, build, test, or lint command. Verify changes in a browser; the VS Code Chrome launch config expects the site served at `http://localhost:8080`, and this repo does not include a server command.
- User-selected audio, photos, and routine videos are converted to data URLs and persisted in browser `localStorage` under `jaystore_` keys. They are local to the browser origin, not repository assets or server data; large uploads may exceed browser storage limits.
