Electron Build/Make Safety Update

Copy these into the station project:
- src/
- main.cjs
- preload.cjs
- package.json

Recommended station commands:
1) npm install
2) npm run clean
3) npm run build
4) npm run start
5) Verify the Electron app shows the new Hybrid/Serial Scanner Routing UI.
6) npm run make
7) Open the newest output under out/make/zip/win32/x64/ or out/<app>-win32-x64/.

Why this update exists:
- npm run dev serves the live Vite source.
- Electron loads dist/index.html.
- If dist or out are stale, the packaged Electron app can look like an old version.
- package.json now runs a clean build before start/package/make.
