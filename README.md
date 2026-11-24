# CommunityCare Queue

A small, installable clinic queue website. It uses Python's built-in HTTP server and a local SQLite database; there are no Python package dependencies. Patients can register and check a token, while staff can sign in to call and complete patients.
Staff can also publish and remove verified upcoming health camps. Camp dates and locations are stored in SQLite and shown on the public homepage.
The doctor/administrator panel is hidden until an administrator signs in. Patient, queue-management, and camp-management API routes also require the signed administrator session; closing the panel locks it and signs out.

## Run on your computer

From this folder in PowerShell:

```powershell
$env:ADMIN_PASSWORD = "set-a-long-unique-password"
$env:SESSION_SECRET = python -c "import secrets; print(secrets.token_urlsafe(32))"
python server.py
```

Open [http://localhost:8000](http://localhost:8000). The database is created at `data/clinic.db`. Keep the server running while using the site. Press Ctrl+C in the server window to stop it.

To store the database somewhere else, set `DATABASE_PATH` before starting the server. `HOST` and `PORT` can also be set for a hosting provider.

## Publish it on the internet

The included `render.yaml` is a deployment template for Render. To publish:

1. Put this project in a GitHub repository and connect that repository to Render.
2. Create a Render Blueprint from the repository. Review the service and persistent-disk plan and its current price before creating it.
3. Set the requested `ADMIN_PASSWORD` to a unique, strong password. Render generates `SESSION_SECRET`; keep both values private.
4. Wait for deployment, then share the HTTPS URL Render gives the service.

The SQLite database is stored on the configured persistent disk. This setup is intentionally a single server instance: do not scale it to multiple instances. A public deployment is not created until you complete these hosting steps and choose a provider account.

## Offline behavior

After the site has first loaded over HTTPS (or on `localhost`), its app shell is cached. Queue counts and department names are cached when available. A patient registration made without a connection is saved in that browser's IndexedDB and submitted when the connection returns; the server assigns its official token at that point. A token looked up successfully on a device can be checked again offline on that device.

Offline registrations and saved tickets are device-specific. They do not appear on another device until they have synced to the server. Avoid using offline registration on a shared device.

## QR registration

On the registration form, choose **Scan clinic QR** and allow camera access. The scanner accepts department codes such as `COMMUNITYCARE:general`, `COMMUNITYCARE:pediatrics`, `COMMUNITYCARE:dental`, `COMMUNITYCARE:eye`, or `COMMUNITYCARE:women`. It can also read a link from the same website containing a `department` parameter, for example `https://your-site.example/?department=general#register`. A scan selects the department; the patient still fills out and submits the form. Camera scanning requires a camera-capable browser and HTTPS (localhost also works). If camera QR scanning is unsupported or unavailable, patients can select the department manually.

## Administrator privacy

Set a strong, private `ADMIN_PASSWORD` and `SESSION_SECRET` before starting or deploying the site. The admin panel stays locked until sign-in, uses an HTTP-only, same-site session cookie, and signs out when the panel closes. Never share the administrator password with patients. This starter has one shared administrator login, not separate doctor accounts or a production identity system; do not expose real patient data without a qualified security review.

## Before using with real patients

This is a starter project, not a certified clinical system. It stores names, ages, phone numbers, and addresses and is **not** ready for regulated or sensitive health information without a qualified security and privacy review. Use HTTPS for any public deployment, restrict and protect staff access, configure backups and a retention policy, and verify your local privacy, consent, and healthcare requirements. The single staff password is intended for a demonstration, not as a substitute for individual staff accounts or production access controls.

Camp dates and clinic contact details are not invented or prefilled; publish verified information before directing patients to the site.
