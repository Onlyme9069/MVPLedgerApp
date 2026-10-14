# MVP Ledger Book

MVP Ledger Book is a React + TypeScript PWA with an Express backend. Firebase/Firestore has been replaced with PostgreSQL (recommended hosted option: Neon). Google Sheets integration remains unchanged.

## Requirements
- Node.js 20 or newer
- A PostgreSQL database. Neon free tier is supported.

## Setup
1. Create a PostgreSQL database in Neon (or use another PostgreSQL provider).
2. Copy `.env.example` to `.env` and set `DATABASE_URL` to the provider's connection string. Keep this value private and do not prefix it with `VITE_`.
3. Install dependencies: `npm install`
4. Start the app: `npm run dev`
5. On first startup, the app creates the required PostgreSQL schema automatically. Opening the app calls a one-time bootstrap endpoint which seeds starter data only when the `users` collection is empty.

The SQL schema is also provided in `database/schema.sql`.

## Initial demo accounts
- `superadmin` / `admin123`
- `admin` / `admin123`
- `aarthik1` / `aarthik123`

Change these starter passwords before using the app with real financial data. The starter records are sample data.

## Build and run
- Development: `npm run dev`
- Production build: `npm run build`
- Production server: `npm start` (set `NODE_ENV=production` in the environment, otherwise the server starts the Vite dev middleware instead of serving `dist/`)

The app stores application records as JSONB documents in PostgreSQL to preserve the existing TypeScript data shape while changing the storage engine. Server sessions and WebAuthn challenges are stored in PostgreSQL too. Message/typing live updates use short polling instead of Firestore realtime listeners.

## Shared Google Sheets integration

The app uses one private Google Sheet for every signed-in user. Sheet reads are proxied through the authenticated backend; Google service-account credentials are never sent to the browser. Only accounts whose current database role is `Admin` or `Super Admin` can run **Sync app records**.

1. Create a new Google Sheet and keep its general access set to **Restricted**.
2. In Google Cloud Console, enable the **Google Sheets API** and create a service account.
3. Create a JSON key for that service account. Keep it secret; do not commit it or send it in chat.
4. Share the new sheet with the service account email and grant it **Editor** access (the sheet remains private to everyone else).
5. Copy the spreadsheet ID from the sheet URL into `GOOGLE_SHEETS_SPREADSHEET_ID`.
6. Configure `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` as server environment variables. Keep these variables out of frontend/Vite-prefixed environment variables.
7. Restart/redeploy the backend. Any logged-in user can view the sheet preview in **Google Sheets Sync**; only Admin/Super Admin can sync current LedgerApp records to the sheet.

The sync operation replaces the sheet's `A1:L5000` contents with the current active ledger records, so admins should confirm the configured sheet is the intended new sheet before syncing. Values are written as plain text/numbers (never evaluated as formulas), and the preview reads the same `A1:L5000` range.
