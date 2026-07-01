# Go-Kart Remastered

Local race timing for go-kart team time trials. One server syncs the display, manager, and official views over your Wi‑Fi.

## One-click start

### Developers (this folder)

1. Install [Node.js 18+](https://nodejs.org/)
2. Double-click:
   - **Mac:** `Start Go-Kart Remastered.command`
   - **Windows:** `Start Go-Kart Remastered.bat`

The first run installs dependencies automatically. Your browser opens the setup page with shareable URLs and QR codes.

### Command line (same thing)

```bash
npm install
npm run launch
```

## Three devices during an event

| Device | Role | URL |
|--------|------|-----|
| Host PC / projector | Public display | `http://<host-ip>:8765/display` |
| Laptop | Administrator (teams) | `http://<host-ip>:8765/manager` |
| iPad | Wedstrijdleider (timing) | `http://<host-ip>:8765/control` |

The setup page shows your LAN IP, copyable URLs, and QR codes. Only the host PC should use `localhost`; other devices need the network IP (e.g. `192.168.x.x`).

## Building a release for others

Use this when you want to hand off a folder or zip to someone else, or ship a new version after making changes.

### Portable package (Node.js required on the target PC)

On **Mac or Windows**, from this project folder:

```bash
npm install
npm run build
```

Output: `release/Go-Kart-Remastered-v<version>-<platform>/`

Zip that folder and share it. The recipient needs Node.js 18+ and double-clicks the launcher inside the folder.

### Standalone package (no Node.js on the target PC)

On **Mac or Windows** (build on the OS you are targeting):

```bash
npm install
npm run build:standalone
```

Output: `release/Go-Kart-Remastered-v<version>-standalone-<platform>/`

Contains a compiled server binary plus `public/` and launchers. Zip and share — recipients do not need Node.js.

### Version bumps

Edit `"version"` in `package.json` before running `npm run build` or `npm run build:standalone`. The release folder name includes the version.

## Requirements

- Node.js 18+ (for development and portable releases)
- All devices on the **same Wi‑Fi/LAN**
- Host firewall allows inbound TCP on port **8765** (override with `PORT=9000`)

## Race day tips

1. Click **"Click to enable sound"** on the display once before the first countdown.
2. Only one device should run the **Wedstrijdleider** view during the event.
3. Use **Racedata back-uppen** on the setup page before and after the event.
4. Race data is auto-saved in `data/session.json` on the host (survives refresh; cleared on Reset).

## Keyboard shortcuts (Wedstrijdleider)

- **Space** — Start / Finish
- **Z** — Undo last action

## Tests

```bash
npm test
```
