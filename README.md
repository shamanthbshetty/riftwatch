# RiftWatch

Watch anime, movies & TV shows.

## Prerequisites

- Node.js 22+ — [https://nodejs.org](https://nodejs.org)

### Install Node.js

**Windows:**
```powershell
winget install OpenJS.NodeJS.LTS
```

**Linux (Debian/Ubuntu):**
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

## Setup

```bash
npm run dev
```

This auto-installs all dependencies on first run, auto-builds the Rust backend
(debug profile) if its binary is missing, and frees ports 3000/3001 if they are
already in use. It prints a health line once the backend and frontend are up.

Add `--open` (or use `npm run dev:open`) to launch your browser automatically.

### Other commands

```bash
npm run check       # lint + typecheck in parallel
npm run build:rust  # release build of the Rust backend
npm run stop        # kill both dev servers (Windows/macOS/Linux)
```

## Environment

Create `.env.local` with your TMDB API key:
```
TMDB_API_KEY=your_key_here
```
