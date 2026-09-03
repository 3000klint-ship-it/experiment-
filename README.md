# UNO Lounge 🃏

A browser-based, mobile-first, real-time multiplayer UNO card game. Players connect to a shared "lounge" over WebSocket, pick avatars, ready up, and play UNO together.

## Features

- Real-time multiplayer via WebSocket (no account needed)
- Mobile-first responsive UI
- Chat with player avatars
- CUT mechanic (penalize a player who forgets to call UNO)
- UNO call button
- Reconnection / resume support
- Host controls: kick players, end game, configure settings
- Spectator mode
- Sound effects (Web Audio API)
- Draw stacking house rules (+2 / +4 stack)

## How to Run

### Prerequisites

- [Node.js](https://nodejs.org) (any recent LTS version)

### Setup

```bash
# 1. Copy the environment template (optional — only needed for Giphy/GIF features)
cp .env.example .env

# 2. Install dependencies
npm install

# 3. Start the server
npm start
# or: node server.js
# or: bash start.sh   (Linux/macOS)
# or: start.bat       (Windows)
```

The server listens on `http://0.0.0.0:3000` by default.

### Play

1. Open `http://your-ip:3000` on any device on the same network.
2. Enter a username and choose a character/avatar.
3. Click **Join Lounge**.
4. Everyone presses **Ready** — the game auto-starts after a 5-second countdown.

To play with friends on other devices, they connect to your machine's LAN IP (e.g. `http://192.168.1.50:3000`).

## Configuration (`.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP/WebSocket port |
| `GIPHY_KEY` | *(empty)* | Giphy API key for GIF avatars (experimental) |

## Project Structure

```
.
├── server.js          # Game server (Express + WebSocket)
├── start.sh           # Linux/macOS launcher
├── start.bat          # Windows launcher
├── public/index.html  # Client (HTML + CSS + JS, single file)
├── tests/             # Test build with auto-playing bots
└── .env.example       # Environment variable template
```

## Test Build (Bots)

The `tests/` folder contains a variant with 5 auto-playing bots for rapidly testing game logic without real players:

```bash
cd tests
npm install
node server.js
```
