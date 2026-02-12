# OurHome

Home display project with:
- `frontend`: React + Vite app for kiosk (`/kiosk`) and admin (`/app`)
- `backend`: Fastify API + SQLite + WebSocket updates

## Quick start

1. Install dependencies:
   - `npm install`
2. Configure backend env:
   - copy `backend/.env.example` to `backend/.env`
3. Run backend:
   - `npm run dev:backend`
4. Run frontend:
   - `npm run dev:frontend`

## Deployment targets

- Frontend static output (`frontend/dist`) for GitHub Pages
- Backend Node process on home PC exposed through Cloudflare Tunnel
