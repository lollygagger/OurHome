# Home Display Project

## Overview
Build a “home display” web app similar to MagicMirror with two modes:

1. **Kiosk Mode** – fullscreen, touchscreen-optimized dashboard for Raspberry Pi 4 + 16" display.
2. **Mobile/Admin Mode** – mobile-friendly interface for managing kiosk content (lists, notes, events, layout).

### Interaction Requirement (Explicit)
- The dashboard and admin experience must be fully editable from a tablet.
- All primary interactions should be touch-screen optimized (large tap targets, touch-friendly spacing, no hover-only controls).
- Users should be able to perform all common management tasks (add/edit/delete/reorder/layout adjustments) directly from a tablet without needing a desktop UI.

The frontend will be static-hosted on GitHub Pages.
The backend will run on a Windows home desktop PC, but must still be accessible from anywhere.

---

## Hosting / Access Requirements (Frontend on GitHub Pages, Backend on Home PC)

### Important note about GitHub Pages
GitHub Pages can only host static files. It cannot run a Node backend.
So we host:
- Frontend (static) on GitHub Pages
- Backend (Node API + DB) on the home PC, exposed securely to the internet via a tunnel

### Target URLs
- Frontend: `https://home.<yourdomain.com>` (GitHub Pages custom domain)
- Backend API: `https://api.<yourdomain.com>` (tunnel to home PC)
- WebSockets: `wss://api.<yourdomain.com>/ws`

### Recommended exposure method: Cloudflare Tunnel
Use Cloudflare Tunnel (cloudflared) so `api.<yourdomain.com>` routes securely to the backend running on the home PC.
- No port forwarding required
- HTTPS handled automatically
- Can restrict access via Cloudflare Access/Zero Trust policies (recommended)

---

## Tech Stack (Recommended)
- Frontend: React + Vite + TypeScript
- Backend: Node.js + Fastify
- Database: SQLite (single-file DB stored on the home PC)
- Realtime updates: WebSockets
- Styling/UI: Tailwind CSS
- Layout system: react-grid-layout (draggable/resizable widgets)

Goal: keep dependencies light and Raspberry Pi friendly.

---

## Modes

### Kiosk Mode
- Fullscreen dashboard UI
- Touch-first interactions (large tap targets)
- Minimal UI chrome
- Live updates via WebSockets
- Optional PIN to exit kiosk mode
- Raspberry Pi loads `https://home.<yourdomain.com>/kiosk` in Chromium kiosk mode

### Mobile/Admin Mode
- Phone-optimized
- Tablet-optimized editing experience (primary admin use case)
- Allows editing data and kiosk layout
- Used to add/remove/complete grocery & todo items, manage notes, manage events, configure widgets/layout
- Requires authentication (because backend is internet-exposed)

---

## Widgets / Panels (MVP)
- Clock (time/date, optional seconds)
- Calendar (local events stored in DB; create/edit/delete from admin)
- Grocery list (add/remove/complete)
- Weather (Open-Meteo; configurable location)
- TODO list (add/remove/complete; optional due/priority)
- Notes (multiple notes; optional Markdown)
- Dashboard grid (draggable/resizable widgets; persisted layouts)

---

## Backend Responsibilities
- REST API for lists/events/notes/layout
- WebSockets for live updates
- SQLite persistence on the home PC
- Auth for admin actions

### Security Requirements (Required)
Because the backend is public:
- Password-based login (single household account is fine for MVP)
- Store password hashed (bcrypt/argon2)
- Use secure sessions (HTTP-only cookies) OR JWT with refresh tokens
- Rate-limit auth endpoints
- CORS locked to frontend origin(s): `https://home.<yourdomain.com>`
- Consider Cloudflare Access policy (recommended) to restrict who can reach `api.<yourdomain.com>`

---

## Suggested Database Schema (SQLite)
- grocery_items (id, text, completed, created_at, updated_at)
- todo_items (id, text, completed, due_date, priority, created_at, updated_at)
- calendar_events (id, title, start_time, end_time, notes, created_at, updated_at)
- notes (id, title, body, pinned, created_at, updated_at)
- dashboards (id, name, is_active, created_at, updated_at)
- dashboard_widgets (id, dashboard_id, type, layout_json, settings_json)

---

## API Endpoints (MVP)

### Auth
- POST /api/auth/login
- POST /api/auth/logout
- GET /api/auth/me

### Grocery
- GET /api/grocery
- POST /api/grocery
- PUT /api/grocery/:id
- DELETE /api/grocery/:id

### Todos
- GET /api/todos
- POST /api/todos
- PUT /api/todos/:id
- DELETE /api/todos/:id

### Events
- GET /api/events
- POST /api/events
- PUT /api/events/:id
- DELETE /api/events/:id

### Notes
- GET /api/notes
- POST /api/notes
- PUT /api/notes/:id
- DELETE /api/notes/:id

### Dashboard
- GET /api/dashboard/active
- PUT /api/dashboard/active
- GET /api/dashboard/layout
- PUT /api/dashboard/layout

---

## WebSocket Events
Endpoint:
- GET /ws (upgrade to WebSocket)

Broadcast events:
- grocery.updated
- todos.updated
- events.updated
- notes.updated
- dashboard.updated

---

## Frontend Requirements

### Routing
- /kiosk = kiosk UI
- /app = mobile/admin UI

### Config
Frontend reads API base URL from environment:
- VITE_API_BASE_URL=https://api.<yourdomain.com>

---

## Deployment Requirements

### Frontend: GitHub Pages
- GitHub Actions builds and deploys Vite static output
- Use custom domain `home.<yourdomain.com>` (CNAME to GitHub Pages)

### Backend: Windows Home PC
- Runs as a Node process on Windows
- Provides HTTP server on localhost or LAN (example: http://localhost:8787)
- Expose publicly via Cloudflare Tunnel:
  - Public hostname: api.<yourdomain.com>
  - Forwards to: http://localhost:8787

### Raspberry Pi
- Loads public URL:
  - Kiosk: https://home.<yourdomain.com>/kiosk
  - Admin: https://home.<yourdomain.com>/app

---

## Acceptance Criteria
- App is reachable from anywhere
- Frontend served via GitHub Pages
- Backend runs on home PC and is reachable via api subdomain
- Admin actions require login (not publicly editable)
- Kiosk updates within 1–2 seconds after edits (WebSockets)
- Layout customization persists
- Works smoothly on Raspberry Pi 4 (4GB)
