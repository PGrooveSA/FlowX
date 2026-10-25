# Known limitations and integrations requiring configuration

## Requires configuration before production

| Area | Current state | What to configure |
|---|---|---|
| Email notifications | Notifications are in-app only. `email.provider` = `none`; each notification records `email_status = not_configured` — nothing claims an email was sent. | An SMTP provider in Supabase Auth (invitations/password resets) and an email worker that sends pending notifications (`email_status = 'pending'` when a provider is set). |
| Auth emails (local) | Invitations and reset links are captured by Mailpit at http://127.0.0.1:55424, not delivered. | Production SMTP and Site URL / redirect URLs. |
| Rate limiting | Supabase Auth's built-in limits apply to sign-in/reset. RPCs have no per-user rate limit. | An API gateway/WAF or Supabase network restrictions for internet-facing deployments. |
| Scheduled checks | `run_scheduled_checks()` is scheduled hourly with pg_cron when available; it can also be run from Settings → Maintenance. | Confirm pg_cron is enabled on the target project. |
| Camera barcode scanning | Uses the browser `BarcodeDetector` API (Chrome/Edge on Android, ChromeOS, macOS). Other browsers fall back to USB scanners or typing. | A JS decoder library if iOS Safari camera scanning is required. |

## Functional limitations

- **PDF output** uses print-optimised pages and the browser's *Save as PDF*; no server-side PDF rendering.
- **Partial issuing then dispatch:** dispatch starts once the approved quantity is fully issued (or reduced through an
  approved amendment). Re-fulfilment after a failed delivery or return is supported (devices can be picked again in
  dispatch-phase states; invoice coverage carries over to the replacement device).
- **Amendments** change approved quantities, recipient, instructions and priority; adding new lines after approval
  requires a new work order. Amendments are possible up to the Issued state; after invoicing use credit notes/returns.
- **Credit notes:** a full credit (releasing allocations) is only possible before payments are recorded; refunds of
  received payments are handled outside the system and a partial credit is issued for the balance.
- **Bulk imports** are validated and committed in chunks (500 devices / 200 institutions per request) from the
  browser; extremely large files (hundreds of thousands of rows) should be loaded with a server-side job using
  `import_devices` or `COPY` into a staging table.
- **Reports** export up to 20 000 rows to CSV/Excel and print up to 2 000 rows; larger extracts should use the
  database directly or a scheduled export.
- **Digital signatures** are captured as an operational record only. Whether they constitute legally valid proof is
  for the organisation's policy (text configurable in Settings → Workflow).
- **Province scope** applies to work orders and, through warehouse province, to warehouse data; finance data
  (invoices) is permission-scoped but not warehouse-scoped.
- Cross-manufacturer duplicate serials are allowed by design (scope = manufacturer); the scanner narrows ambiguous
  serials by work order model and blocks if still ambiguous.

## Development-only items (must not reach production)

- `supabase/seed.sql`, `scripts/seed-demo.mjs`, the demo accounts and `.env.local`.
- The local anon/service keys printed by `supabase status` are the public demo keys of the Supabase CLI.
