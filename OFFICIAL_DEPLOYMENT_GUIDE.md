# Deployment: VPSDime, Coolify and PostgreSQL

The app runs on your VPSDime VPS, managed by Coolify, with PostgreSQL. Repository and branch names do not determine the hosting provider. This guide does not change your existing VPS or deploy the code.

## Before updating an existing site

1. Take a PostgreSQL backup and verify that you can restore it to a **separate** database. Preserve existing volumes, secrets and settings. Do not point a test site at your production database.
2. Review all pending changes, including payroll and Store, and test against a restored copy using the same PostgreSQL version, permissions and Coolify settings. Several schema changes run automatically; a code rollback alone does not undo a database migration.
3. In Coolify, check the application environment variables and retain the existing production `DATABASE_URL`, `ADMIN_PASSWORD` and `SESSION_SECRET`. Do not rotate these accidentally: changing `SESSION_SECRET` invalidates sessions. Set `NEXT_PUBLIC_SITE_URL` to your actual `https://` domain for **both build and runtime** (public Next.js variables may be embedded at build). See `.env.example` for names; never commit real secrets.
4. Confirm DNS points at your VPS and Coolify's reverse proxy has valid HTTPS. Expose the Next.js app through Coolify's proxy (normally container port 3000); do not expose PostgreSQL publicly. Database connections must work from the application container, not just from the VPS host. Grant the application DB user the permissions needed for the app's migrations, including creating tables, indexes, functions and triggers.
5. Keep **one app replica/process** unless the in-memory real-time event hub and rate limits are redesigned for multiple instances. Verify the proxy keeps Server-Sent Events streams open. Check disk capacity, logs, database and host backups, and alerting.
6. Test on staging before production: login, POS/order flows, stations and Done, print and delivery, Store issues/direct imports, payroll, attendance scanner and notifications. Open `/store` before relying on ingredient tracking; opening it installs the stock trigger. Set recipes and opening balances and conduct physical counts. Existing completed sales are not backfilled.

## Attendance device

The firmware is in `hardware/fana_attendance_esp32`. Upload the updated sketch separately: merging or deploying the website does **not** update the ESP32. Set `serverURL` to the actual HTTPS site. If enabling `ATTENDANCE_DEVICE_TOKEN` in Coolify, first provision the same value securely into the device firmware and flash it, then set the server variable. Avoid committing the token. Coordinate the change: an old device without the token will be rejected when it is enabled. Test scans, enrollment, offline recovery and LCD on the physical unit. See the device README for limitations.

## Optional scheduled receipt cleanup

Automatic receipt cleanup is not an in-process worker. If you want it, configure a Coolify scheduled task to POST to `/api/tickets/cleanup` with `Authorization: Bearer <RECEIPT_CLEANUP_SECRET>` and set the same long random secret in the app environment. Ensure the scheduler receives the secret securely and that its logs do not expose it. Test with a suitably isolated database and review retention first. The admin manual cleanup is separate. Check the task response and application logs; cleanup failures return an error rather than a misleading zero count.

## After deploying

Check Coolify build and application logs, HTTPS, database connectivity, app health and the workflows above. `/api/setup` is an authenticated, **mutating** initialization/seed and smoke-test route, not a harmless health check; use it only when its effects are appropriate and after a backup. Keep the backup and a tested rollback plan. Changes to the website and device firmware have independent deployment steps.
