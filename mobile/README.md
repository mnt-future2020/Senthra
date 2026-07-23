# Senthra Engineer — Mobile App

React Native + Expo (SDK 57, expo-router) mobile app for **field engineers**, mirroring the web
dashboard's Engineer Portal. It talks to the same `backend/` REST API with the same auth model —
**no backend changes were required**.

## Features (parity with the web engineer portal)

- **Sign in** with email/password (same accounts as the web app), including the first-login
  forced password change for invited engineers. Sessions respect the backend's 2-device cap.
- **Dashboard** — van stock summary, recent stock activity, quick actions.
- **Jobs** — assigned job list with search/status filters; job detail with kit lines,
  goods tallies (issued/used/returned/on-van), pickup warehouses and van sources;
  full lifecycle actions: **accept / reject / start / complete** (declaring used quantities
  per kit line + work summary).
- **Kit requests** — raise additional-kit requests (IRM catalogue + the job's customer stock +
  misc free-text lines) from a job; track and cancel them.
- **My Stock** — IRM, customer consignment, and misc holdings on the van, plus the full
  cursor-paginated movement history.
- **Transfers** — van-to-van hand-overs: request stock from another engineer's van
  (company/customer search), approve/decline as the holder, cancel as the requester, and
  **sign-on-glass acknowledgment** when a signature is required.
- **Field stock (VSR)** — non-job restock requests (catalogue search, preferred warehouse,
  priority) and returns (van holdings → warehouse); request detail with per-line approved/
  fulfilled progress, pickup warehouse addresses, and fulfilment history; cancel / cancel-remaining.
- **Account** — profile, change password, active devices (+ revoke others), sign out.

## Getting started

```bash
cd mobile
npm install
cp .env.example .env        # then set EXPO_PUBLIC_API_URL
npx expo start
```

- Press `a` for the Android emulator, `i` for the iOS simulator, or scan the QR code with
  **Expo Go** on a physical device.
- The backend must be running (`cd backend && pnpm dev`).

### Choosing `EXPO_PUBLIC_API_URL`

| Where the app runs | URL |
|---|---|
| iOS simulator | `http://localhost:8000` |
| Android emulator | `http://10.0.2.2:8000` |
| Physical device (Expo Go) | `http://<your-computer's-LAN-IP>:8000` — same Wi-Fi network |
| Production build | `https://…` — HTTPS is required (auth cookies are `Secure` in production) |

## How auth works (no backend changes)

- `POST /auth/login` returns the access token in the body **and** sets the `senthra_access` /
  `senthra_refresh` httpOnly cookies; React Native's native networking stores and resends those
  cookies automatically.
- The app also keeps the access token in **expo-secure-store** and sends it as
  `Authorization: Bearer` (the backend accepts either; cookie wins when present).
- On a 401 the client calls `POST /auth/refresh` once (refresh cookie rides along natively,
  and the endpoint also accepts a body `refreshToken`), stores the fresh token from the
  response body, and replays the original request — the same silent-refresh contract as the
  web `lib/api.ts`.

## Project layout

```
src/
  app/                    expo-router routes
    _layout.tsx           root stack + AuthProvider
    index.tsx             entry gate (splash → login / set-password / tabs)
    login.tsx, set-password.tsx
    (tabs)/               overview · jobs · stock · requests · account
    jobs/[id].tsx         job detail + lifecycle actions
    jobs/complete.tsx     used-quantities completion form
    kit-requests/new.tsx  additional-kit composer
    transfers/            [id] detail · new request · sign (signature pad)
    van-stock/            [id] detail · new restock · return
  components/ui.tsx       shared UI kit (Card, Button, Badge, Stepper, …)
  lib/                    api client, auth context, theme, formatting, useLoad hook
  services/               typed API wrappers (1:1 with the web frontend's services)
  types.ts                domain types (mirrors frontend/src/types)
```

## Not yet implemented (backlog)

- **Realtime (Socket.IO)** — the web app gets live refetch signals; here data refreshes on
  focus / pull-to-refresh. Wiring `socket.io-client` with the access token in the handshake
  `Cookie` header works against the existing backend.
- **Push notifications** — needs a small backend addition (Expo push tokens + send on events).
- **Attachments/photos** on kit/van-stock/transfer requests (`expo-image-picker` → the existing
  base64 upload endpoints).
- **Barcode scanning** (`expo-camera`) — scanning is currently a warehouse/reviewer-side flow.
- **Forgot password** in-app (backend endpoint exists; the reset link currently lands on the web app).
- Google sign-in, dark mode, offline caching.
