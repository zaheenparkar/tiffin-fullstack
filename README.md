# Zeba's Tiffin — Order Manager (full-stack)

A real client/server app: a Node.js + Express API with its own server-side data store,
and a frontend that talks to it over HTTP. Orders placed on a customer's phone are
immediately visible to Zeba or Tabrez on any other device — this is the version that
fixes the "doesn't sync between devices" limitation of the earlier prototype.

```
tiffin-fullstack/
├── backend/           Express API — also serves the frontend
│   ├── server.js
│   ├── package.json
│   └── data/          created automatically on first run (db.json)
├── frontend/
│   └── index.html     the whole UI — calls the API, no build step
└── README.md           you are here
```

## What's new in this version

- **Real shared backend** — all data (orders, customers, menu, settings, dish of the day)
  lives server-side. Local development uses `backend/data/db.json`; production uses
  PostgreSQL when `DATABASE_URL` is set.
- **Subscription proration** — each subscription has an "included quantity" (e.g. 1 or 2
  tiffins per order). Order more than that in one go, and the extra units are charged at
  the one-time per-portion price — never the monthly rate. This applies whichever way you
  mix veg and non-veg, and whether the subscription covers one type or both (veg is
  applied against the included quantity first, then non-veg).
- **Order payment status**, separate from order status (pending/confirmed/declined/delivered).
- **Subscription payment status**, tracked separately from individual order payments.
- **"Settle everything now"** — one button on a customer's Manage panel that marks their
  subscription paid *and* every one of their outstanding unpaid orders paid, in one go —
  for customers who'd rather square it all up together instead of order-by-order.
- Passwords are hashed (bcrypt) server-side — never stored or sent in plain text.
- Login sessions use JWTs, valid for 30 days, sent as a bearer token on every request.

## Running it locally (2 minutes)

You need [Node.js](https://nodejs.org) 18 or newer installed.

```bash
cd tiffin-fullstack/backend
npm install
npm start
```

Then open **http://localhost:4000** in a browser — the backend serves the frontend
directly, so there's nothing else to run. Log in with:

- `zeba` / `zeba123`
- `tabrez` / `tabrez123`

**Change both passwords before using this for real** — create your own admin flow, or for
now just edit the hashed values in `backend/data/db.json` after first boot (use
`node -e "console.log(require('bcryptjs').hashSync('yournewpassword',10))"` to generate a
hash, and paste it into the relevant `passwordHash` field, then restart the server).

## Deploying on Railway with PostgreSQL

Railway is the recommended production setup for this app. Add one PostgreSQL service and
one Node service from this repository. The app creates its `app_state` table on startup
and stores the application data there whenever `DATABASE_URL` is set.

1. Push the project to a private GitHub repository. Do not commit `backend/data/`.
2. In Railway, create a project and add a **PostgreSQL** service.
3. Add a service from the GitHub repository and set its root directory to `backend`.
4. Use `npm install` as the build command and `npm start` as the start command.
5. Add these variables to the Node service:
  - `DATABASE_URL`: reference the PostgreSQL service's connection variable.
  - `JWT_SECRET`: a long random value, different from the development default.
  - `NODE_ENV`: `production`.
6. Deploy and open the generated public URL. Railway provides HTTPS automatically.

### Migrating the local database

After creating the Railway PostgreSQL service, copy its connection string into a local
PowerShell terminal and run this from the project root:

```powershell
$env:DATABASE_URL = "your-railway-postgres-connection-string"
$env:NODE_ENV = "production"
cd backend
npm run migrate:postgres
```

The migration refuses to overwrite an existing production database. It copies the current
`backend/data/db.json`, including admin accounts, customers, settings, menu, and orders.
After migration, change both admin passwords before sharing the public URL.

### Railway deployment checks

- Confirm the logs show `Zeba's Tiffin API listening on port ...`.
- Open `https://your-service-url/api/health` and confirm `ok: true`.
- Log in with the migrated admin account.
- Create a test customer and order, then verify records remain after a redeploy.

### Option B — Your own VPS (e.g. the Hostinger VPS already set up)
1. Copy the `backend` folder to the server (`scp` or `git clone`).
2. `cd backend && npm install --production`
3. Run it persistently with a process manager so it survives reboots/crashes:
   ```bash
   npm install -g pm2
   JWT_SECRET="a-long-random-string" pm2 start server.js --name zebas-tiffin
   pm2 save && pm2 startup
   ```
4. Point a domain/subdomain at it via Nginx (reverse proxy to `localhost:4000`) and add
   HTTPS with `certbot` — important, since login credentials are sent over this connection.

### Option C — Docker (works the same anywhere)
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY backend/package.json ./
RUN npm install --production
COPY backend/ ./
COPY frontend/ ../frontend/
ENV JWT_SECRET=change-me
EXPOSE 4000
CMD ["node", "server.js"]
```
Build and run: `docker build -t zebas-tiffin . && docker run -p 4000:4000 zebas-tiffin`

## Before going live — a short but important checklist

- [ ] Set `JWT_SECRET` to a long random value (not the default in the code) via an
      environment variable, on whichever host you use.
- [ ] Change the `zeba` / `tabrez` passwords from the defaults.
- [ ] Put it behind HTTPS (Railway/Render do this automatically; on a VPS use certbot).
- [ ] Use PostgreSQL for production. Keep `backend/data/db.json` only as a local backup or
  migration source.
- [ ] The included quantity, pricing, and lead-time logic all live in one function
      (`priceOrder` in `server.js`) — that's the one place to touch if the business rules
      change later.

## Growing past this

The initial PostgreSQL adapter stores the app state as one JSON document to preserve the
existing API with minimal risk. If the business grows significantly, split this document
into normal PostgreSQL tables and add database-level transactions for reporting and
high-volume concurrent editing.
