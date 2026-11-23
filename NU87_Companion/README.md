# NU87 Companion (macOS menu-bar app)

Build / run:
```sh
./build.sh && open "build/NU87 Companion.app"
```
First run: allow **Bluetooth**, and grant **Accessibility** (needed only for shortcuts and media keys; app/URL actions work without it).

- Protocol: board notifies `EVT|seq|key(1-9)|S/D/H|action_id` on the existing NUS TX characteristic; Mac replies `ACK,seq,OK|FAIL|UNSUP` on RX (shown as a toast on the board). Only PC actions are sent (ids 1-4, 10-13, 20-23); local ones (30, 31, 40) stay on the board.
- Action map: `~/Library/Application Support/NU87Companion/config.json` (keyed by firmware action id, re-read on every event). Types: app, url, keys, media, unsupported. There is no shell-command type.
- Log: `~/Library/Logs/NU87Companion.log`.
- Test without hardware: `"build/NU87 Companion.app/Contents/MacOS/NU87Companion" --run 1` or `--evt "EVT|1|1|S|1"`.
- Codex must be installed as `Codex.app` (or set its name/bundle id in config.json). AI Accept/Stop (3, 4) are `unsupported` on purpose.
