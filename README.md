# DeviceFlow

Device lifecycle, work order, warehouse, invoicing and dispatch management for devices distributed to schools, teachers,
learners and institutions. Every physical device has its own permanent record; every allocation, repair, invoice,
movement and handover is validated in the database and written to an append-only audit trail.

- **Frontend:** React 18, TypeScript, Vite, Tailwind CSS (shadcn-style components on Radix), TanStack Query & Table,
  React Hook Form + Zod, Recharts, Lucide.
- **Backend:** Supabase (PostgreSQL 17, Auth, Storage, Edge Functions). All business rules live in versioned SQL
  migrations as `SECURITY DEFINER` functions behind Row Level Security.
- **Tests:** Vitest + React Testing Library (unit/component) and an integration suite that exercises the real database.

## Running it on this computer

Prerequisites: Node.js 20+ (tested on 24), Docker Desktop running.

```bash
npm install
```

```bash
npx supabase start
```

```bash
npm run setup:env
```

```bash
npm run db:reset
```

```bash
npm run setup:demo
```

```bash
npm run dev
```

Open http://localhost:5180. `npm run setup:demo` prints the demo accounts; their password is the `DEMO_USER_PASSWORD`
value it writes to `.env.local` (generated randomly; never committed).

For a production-style local build instead of the dev server, run `.\start-deviceflow.ps1` (builds and serves on
port 5180).

### Local service ports

DeviceFlow uses its own port range so it can run alongside other Supabase projects:

| Service | URL |
|---|---|
| Web app | http://localhost:5180 |
| Supabase API / Auth / Storage / Functions | http://127.0.0.1:55421 |
| PostgreSQL | postgresql://postgres:postgres@127.0.0.1:55422/postgres |
| Supabase Studio (database admin) | http://127.0.0.1:55423 |
| Mailpit (captures invitation and password-reset emails) | http://127.0.0.1:55424 |

### Demo accounts (development only)

| Email | Role | Scope |
|---|---|---|
| admin@deviceflow.test | Administrator | All |
| creator@deviceflow.test | Standard User | All |
| approver@deviceflow.test | Approver | All |
| manager@deviceflow.test | Warehouse Manager | JHB-01 |
| operator@deviceflow.test | Warehouse Operator | JHB-01 |
| technician@deviceflow.test | Technician | All |
| invoicer@deviceflow.test | Invoicer | All |
| dispatcher@deviceflow.test | Dispatcher | JHB-01 |
| auditor@deviceflow.test | Auditor (read-only + audit) | All |

The demo script drives the real workflow functions, so the database contains work orders in most states, a
completed end-to-end order, a partial dispatch with a missing device, a draft and issued invoices, a replacement
transaction, a repair in progress, a pending stock adjustment, a goods receipt and an **open serial mismatch**
(WO00000006 expects `ABC123`; `XYZ789` was scanned and blocked).

The seed data (`supabase/seed.sql`) is fictional and runs only on `supabase db reset` against the local stack.
`scripts/seed-demo.mjs` refuses to run against a non-local URL.

## First administrator (real installations)

No default administrator or password ships with the system. With `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
set for the target project:

```bash
npm run create-admin -- --email admin@your-org.example --name "Full Name"
```

The password is prompted (or read from `ADMIN_PASSWORD`), must be at least 12 characters and is never stored. The
script refuses to run if an administrator already exists. Further users are invited from **User Management**; the
invitation email lets them set their own password.

## Tests

```bash
npm test
```

```bash
npm run test:integration
```

`npm test` runs unit and component tests (money handling, CSV safety, permission-filtered navigation, scanner input,
confirmation dialogs, form validation). `npm run test:integration` runs acceptance scenarios A–L from the specification
against the local database with freshly created users and devices (duplicate serials, anti-swap mismatch, faulty
devices, concurrent reservation, invoice quantity and duplicate invoicing, partial dispatch and delivery, replacement,
backend permission checks, cancellation/credit notes, concurrent dispatch) plus audit-trail immutability and the
public delivery link. Integration runs leave `IT…`-tagged users and devices in the CPT-01 warehouse; run
`npm run db:reset && npm run setup:demo` for a clean demo database.

## Project layout

```
supabase/
  migrations/      versioned schema, business functions, RLS and views (apply in order)
  functions/       admin-users edge function (invites, deactivation; holds the service key server-side)
  seed.sql         development-only reference and demo stock
src/
  lib/api.ts       data-access layer (RLS-protected reads, RPC writes, uploads)
  components/      design system (ui/), data table, scanner input, import wizard, attachments
  pages/           one folder per module
scripts/           env writer, first-admin setup, demo workflow seeding
tests/integration  database-level acceptance tests
docs/              roles & business rules, backup & recovery, limitations
```

## Deployment

1. Create a Supabase project (or self-host Supabase). Link it with `npx supabase link --project-ref <ref>` and apply
   migrations with `npx supabase db push`. **Do not run `seed.sql` or `setup:demo` in production.**
2. Deploy the edge function: `npx supabase functions deploy admin-users`. Set `APP_ORIGIN` to your web origin.
3. In Supabase Auth settings: keep public sign-up disabled (invite-only), set the Site URL and redirect URL to
   `https://<your-domain>/reset-password`, configure a real SMTP provider, and review the auth rate limits.
4. Build the frontend with production values for `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and `VITE_APP_URL`
   (`npm run build`), then serve `dist/` from any static host with an SPA fallback to `index.html` and HTTPS.
5. Create the first administrator with `npm run create-admin`, then configure organisation details, VAT, numbering and
   master data in **System Settings**.

Only `VITE_*` variables reach the browser. The service-role key is used only by the edge function and the
admin/demo scripts.

See [docs/ROLES_AND_BUSINESS_RULES.md](docs/ROLES_AND_BUSINESS_RULES.md), [docs/BACKUP_AND_RECOVERY.md](docs/BACKUP_AND_RECOVERY.md)
and [docs/LIMITATIONS.md](docs/LIMITATIONS.md).
