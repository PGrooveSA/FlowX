# Backup and recovery

DeviceFlow's system of record is the PostgreSQL database plus the private `attachments` storage bucket
(photographs, proof-of-delivery files). Both must be backed up together.

## Local installation (this computer)

The local Supabase stack keeps data in Docker volumes that survive `npx supabase stop` / `start`. They are **removed**
by `npx supabase db reset` and by `npx supabase stop --no-backup`. Never run either on a database with real data.

### Database dump

```bash
npx supabase db dump --local --data-only -f backups/deviceflow-data.sql
```

```bash
npx supabase db dump --local -f backups/deviceflow-schema.sql
```

Or with plain `pg_dump` (custom format, best for restore):

```bash
pg_dump "postgresql://postgres:postgres@127.0.0.1:55422/postgres" -Fc -n public -n app_private -n auth -n storage -f backups/deviceflow.dump
```

Include the `auth` schema so users and their IDs (referenced by audit and operational records) are preserved.

### Storage files

Files live in the `supabase_storage_deviceflow` volume. Back it up with:

```bash
docker run --rm -v supabase_storage_deviceflow:/data -v "${PWD}/backups:/backup" alpine tar czf /backup/storage.tgz -C /data .
```

### Restore (local)

1. `npx supabase start` (fresh stack, migrations applied).
2. `pg_restore --clean --if-exists -d "postgresql://postgres:postgres@127.0.0.1:55422/postgres" backups/deviceflow.dump`
3. Restore the storage volume tarball into `supabase_storage_deviceflow`.
4. Verify: sign in, open the dashboard, check the latest audit entries and a recent proof-of-delivery file.

Note: `audit_logs`, `device_movements` and `work_order_status_history` have triggers that block UPDATE/DELETE. A
`pg_restore --clean` drops and recreates them, which is allowed; row-level edits are not.

## Hosted Supabase

- Enable daily backups and **Point-in-Time Recovery** (Pro plan or above) for the production project.
- Additionally schedule an off-platform `pg_dump` (e.g. nightly) to separate storage you control, encrypted at rest.
- Back up Storage objects with the S3-compatible API (`rclone sync`) on the same schedule.
- Keep at least: 7 daily, 4 weekly, 12 monthly copies — align with your records-retention and POPIA policies.

## Recovery objectives (suggested)

| Item | Target |
|---|---|
| RPO (data loss) | ≤ 24 h with nightly dumps; minutes with PITR |
| RTO (time to restore) | ≤ 4 h |
| Restore test | Quarterly into a staging project, with a documented checklist |

## Migrations and rollback

Schema changes are versioned in `supabase/migrations`. Production changes are applied with `npx supabase db push`
after testing on staging. Roll forward with a corrective migration rather than editing applied migrations; take a
backup immediately before every production migration.
