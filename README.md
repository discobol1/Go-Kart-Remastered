# Go-Kart Remastered

Local race timing for go-kart team time trials. One Node server syncs three browser views over your Wi‑Fi.

## Quick start

On the **host PC** (connected to the projector/TV):

```bash
npm install
npm run start:host    # starts server and opens the public display
```

Or without auto-opening the browser:

```bash
npm start
```

Then open **http://localhost:8765/** for the setup page with shareable URLs and QR codes.

## Three devices

| Device | Role | URL |
|--------|------|-----|
| Host PC / projector | Public display | `http://<host-ip>:8765/display` |
| Laptop | Race manager (add teams) | `http://<host-ip>:8765/manager` |
| iPad | Race official (timing) | `http://<host-ip>:8765/control` |

The server prints your LAN IP on startup. The setup page shows copyable URLs and QR codes for the laptop and iPad.

**Important:** Only the host PC should use `localhost`. Other devices must use the host's network IP (e.g. `192.168.x.x`).

## Requirements

- Node.js 18+
- All devices on the **same Wi‑Fi/LAN**
- Host firewall allows inbound TCP on port **8765** (override with `PORT=9000 npm start`)

## Race day tips

1. Click **"Click to enable sound"** on the display once before the first countdown.
2. Only one device should run the **Race Official** view during the event.
3. Use **Backup Race Data** on the setup page before and after the event.
4. Race data is auto-saved on the server in `data/session.json` (survives refresh; cleared on Reset).

## Keyboard shortcuts (Race Official)

- **Space** — Start / Finish
- **Z** — Undo last action
