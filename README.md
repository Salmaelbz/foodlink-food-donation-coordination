# FoodLink

FoodLink is a responsive web MVP for coordinating food donation offers, community requests, coordinator-reviewed matches, assigned deliveries, receipt confirmation, issue follow-up, and pilot reporting.

The default app runs locally with Flask and SQLite and seeds clearly labeled demonstration data. It does not rely on a third-party service to run.

## Run locally on Windows

From this folder in PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python app.py
```

Open <http://127.0.0.1:5000>. The first run creates `foodlink.sqlite3` and loads demo data. The database is local and is excluded from Git.

Demo password: `demo1234`

| Role | Demo email |
| --- | --- |
| Administrator | `admin@foodlink.local` |
| Coordinator | `coordinator@foodlink.local` |
| Donor | `donor@foodlink.local` |
| Community partner | `partner@foodlink.local` |
| Driver / volunteer | `driver@foodlink.local` |

The sign-in page also includes shortcuts for each role. These credentials and records are for local demonstration only.

## Configuration

Copy `.env.example` as a reference; the app intentionally does not load `.env` files implicitly. Set environment variables in the host or shell:

```powershell
$env:FLASK_SECRET_KEY = "replace-with-a-long-random-secret"
$env:FOODLINK_DATABASE = "C:\data\foodlink.sqlite3"
$env:FOODLINK_DEMO_MODE = "false"
$env:FOODLINK_SEED_DEMO = "false"
$env:FLASK_ENV = "production"
```

`FOODLINK_DEMO_MODE` labels the interface as demonstration data. `FOODLINK_SEED_DEMO=false` disables the seeded sample organizations and accounts. For a non-demo database, create the first administrator interactively:

```powershell
python -m flask --app app create-admin
```

The initial administrator must use a password of at least 12 characters. Then register pilot organizations and create authorized team accounts from **Organizations & team**. Keep the session secret private. Configure HTTPS at the hosting proxy so secure cookies are used, and use a persistent database volume.

The application uses the schema in `migrations/001_initial.sql` to initialize a new SQLite database. Back up the database file and keep the migration with the deployed application.

## Test

```powershell
python -m unittest discover -s tests -v
```

The automated tests cover role scoping, CSRF protection, duplicate request submissions, coordinator review, approval requirements, delivery status progression, receipt discrepancies, correction history, issue resolution, quantity reservation/release, reporting, and CSV export.

## Deployment

This app is a same-origin Flask application. For a Linux host with persistent storage, install the dependencies and run the Waitress WSGI server:

```sh
python -m pip install -r requirements.txt
waitress-serve --listen=0.0.0.0:8000 app:app
```

Set `FLASK_SECRET_KEY` to a secure random value, point `FOODLINK_DATABASE` at a persistent writable path, and set `FOODLINK_DEMO_MODE=false` and `FOODLINK_SEED_DEMO=false` before creating the first administrator. Put the service behind HTTPS and an appropriately configured reverse proxy. Do not use ephemeral filesystem hosting for SQLite. For multi-instance or higher-volume operation, migrate to a managed relational database and add deployment-specific backup, monitoring, and account recovery services before launch.

No Supabase, email, SMS, map, or external analytics credentials are included or required. Email/messaging delivery is explicitly unconfigured; in-app notifications continue to work.

## Global hunger map data

The public world map shades countries by the **share of people who are undernourished** (FAO prevalence-of-undernourishment indicator), with white-to-red bands by prevalence. This is not an acute food crisis, famine, or real-time situation map and is not a FoodLink pilot result. It shows each country's latest available estimate; years vary (the bundled snapshot is mostly 2023). The FAO reports estimates below 2.5% as 2.5% because of uncertainty at very low levels. Countries without observations use a separate gray fill.

The bundled data snapshot is refreshed from [FAO data distributed by Our World in Data](https://ourworldindata.org/grapher/prevalence-of-undernourishment), with [Natural Earth](https://www.naturalearthdata.com/) country boundaries. Map data is bundled, so the application does not need a live third-party map or data service to display it. Maintainers can deliberately refresh both source snapshots and generated files with:

```powershell
python scripts\update_hunger_map.py
```

Review the new source date and country observation years before publishing an updated snapshot.

## Demonstration workflow

1. Sign in as the demo donor and add a food offer with category, quantity/unit, pickup window, freshness, allergens, and handling details.
2. Sign in as the community partner and submit a request. Use only organization-level destination and operational needs—never individual recipient information.
3. As coordinator, review the food offer and complete each configured checklist item. Inspect the suggested category/unit and timing factors, then propose a quantity and delivery window.
4. Sign in as the donor and partner in turn and accept the proposal. Return as coordinator, assign the demo driver, and confirm the match. The reservation check runs again inside a database write transaction.
5. As driver, move the delivery through pickup-in-progress, collected (record the amount), and in-transit. As the partner, record the received quantity, condition, and acceptance.
6. Try a short quantity to create a discrepancy. As coordinator, add follow-up and resolve the issue. The partner can append a corrected receipt without overwriting the original confirmation.
7. Review the updated pilot reports and export the delivery CSV. Reports separate categories and units, count only fully confirmed deliveries as completed, and identify unavailable measures rather than treating them as zero.

The seed dataset includes one pending proposal and a partially delivered example with an open issue to make the approval and exception states visible before running the workflow.

## Assumptions and limitations before a live pilot

- Sample people, organizations, locations, dates, and transactions are invented demonstration records. No real pilot district, partner list, launch date, food-safety procedure, or local legal rule is asserted.
- The pilot administrator must confirm the district, partner participation, accepted categories/units, handling rules, applicable local requirements, privacy/retention policy, and transportation capability.
- Food matching suggestions are advisory. Human coordinators must review safety and suitability; donors and partners must both accept; the coordinator alone confirms and assigns the delivery.
- Authorization is enforced in Flask route handlers with organization-scoped queries, signed sessions, CSRF tokens, and role checks. Contact details are returned only to coordinators/admins or a driver assigned to that delivery. Individual recipient records are not modeled.
- SQLite transactions serialize match confirmation and recheck confirmed quantities to avoid over-allocation. Use a managed database and migration plan before scaling to multiple application instances.
- Password-reset email, self-service participation, external email/SMS notifications, and automated data-retention deletion are not configured. Password-reset requests return a neutral message but do not send an email.
- Coordinator time, transport cost, spoilage quantities, and several feedback fields can be missing. Reports label these gaps and avoid unsupported claims about hunger, nutrition, or food-waste outcomes.
- The UI uses local demonstration accounts by default. Disable demo seeding, provision an administrator, use HTTPS and a strong secret, establish backups and retention controls, and review security operations before production.
