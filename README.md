# COMA - Beta

**A place of your own for your people.**

COMA is a small-group chat app. Create an account, invite someone with a personal link, and keep the conversation going in a calm space. It runs on a Python server and stores data in SQLite.

**Version 0.1 beta.** The core features work, but this is an early release for a small test group.

![COMA on desktop with the conversations list and an open private chat](docs/screenshots/coma-chat.png)

*Screenshots show the real app with fictional example accounts and messages. A new COMA installation starts empty.*

## What works

- Accounts: register, sign in, change your display name, and sign out.
- Personal invitations: single-use links valid for seven days that can be revoked.
- Private conversations between two people with live updates and automatic reconnection.
- Saved and read status, search, unread filters, and older message history.
- Contact blocking and abuse reports, which the administrator can review.
- A responsive interface for desktop and mobile.

## Screenshots

### Welcome screen

![COMA welcome and account registration screen](docs/screenshots/coma-welcome.png)

### Mobile conversation

<img src="docs/screenshots/coma-mobile.png" alt="COMA mobile view with an open conversation and message composer" width="320">

## Run on Windows

If you have the built app, double-click **COMA.exe**. A local build is available at `dist/COMA.exe`. Python is not required on the destination computer. COMA opens your browser and a console window. Keep the console open while using the app; press **Ctrl+C** there to stop it.

The Windows executable was built locally and passed its bundled startup test. The `dist/` directory is excluded from Git. A GitHub download will be available only after the executable is attached to a release.

## Run with Python

Requires **Python 3.12 or newer**. The server uses only the Python standard library.

From the COMA directory:

```sh
python server.py --open
```

On macOS or Linux, use `python3` if necessary. You can also open **http://127.0.0.1:4310** yourself. On Windows, double-click `start-coma.cmd`. Press **Ctrl+C** to stop the server.

### Start your first conversation

1. Register the first account. It becomes the administrator.
2. Choose **Invite someone** and copy the personal invitation link.
3. Open the link in a different browser or private window to test a second account.
4. Register that account and begin chatting.

Registration needs a name, username, and a password of at least 12 characters. Email is not required. After the first account, new users need an invitation.

By default, COMA listens only on your computer. For conversations across devices, run one shared server behind HTTPS. A link pointing to `127.0.0.1` works only on the computer that created it.

## Build desktop apps

| Platform | Current status |
| --- | --- |
| Windows | EXE built locally and startup test passed. |
| macOS | APP and DMG build scripts are ready; the Mac build has not yet been run or tested. |

To build on Windows, install PyInstaller 6.22.3 and run `python build.py`. A DMG must be built on a Mac. See [BUILDING.md](BUILDING.md) for detailed instructions and storage locations. The macOS build is not notarized or signed with an Apple Developer certificate.

## Data storage

Accounts, password hashes, messages, sessions, and invitations are stored in `coma.sqlite`.

| How you start COMA | Default data directory |
| --- | --- |
| `python server.py` | `data/` next to the source code |
| Windows desktop app | `%LOCALAPPDATA%\COMA\data` |
| macOS desktop app | `~/Library/Application Support/COMA/data` |

The desktop app does not automatically import the source version's data. Set `DATA_DIR` to use another location. Stop the server before backing up the complete data directory. `.gitignore` excludes personal databases, `.env` files, and local builds. The EXE does not contain developer accounts or messages.

## Privacy and beta limitations

Passwords are hashed with scrypt and a unique salt. Only conversation participants can access their conversation through the app. Sessions expire after seven days. The server checks the origin and CSRF token on write requests and limits sign-in attempts and message sending.

**Messages are not end-to-end encrypted, and the database is not encrypted on disk.** The server administrator can read stored data. Use HTTPS on a shared server.

This beta does not yet support password recovery, email verification, self-service account deletion or data export, group conversations, calls, file attachments, or push notifications when the app is closed. There is no offline outbox. Drafts and unconfirmed messages exist only in the current browser window and may be lost when it closes or reloads.

## Host a small test group

Use one Python process with a persistent data directory. Create the administrator account yourself before making the server accessible to others. Put a TLS reverse proxy in front of COMA and disable buffering for `/api/events`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen address for `server.py`. |
| `PORT` | `4310` | Server port. |
| `DATA_DIR` | `data/` beside `server.py` | Persistent SQLite directory. |
| `PUBLIC_ORIGIN` | Derived from the local Host header | Set to the exact HTTPS origin when hosting. |
| `COOKIE_SECURE` | Off | Set to `1` for HTTPS. |
| `MAX_USERS` | `100` | Maximum number of accounts. |

The Python server does not load `.env` automatically; set variables in the shell. The desktop launcher binds to `127.0.0.1`, so use `server.py` for hosting. Live connections and rate limits are process-local. Behind a reverse proxy, visitors share that proxy's IP-based limit.

## Tests

```sh
python -m unittest discover -s test -p test_python.py -v
```

The four Python integration tests use temporary databases. They cover registration, invitations, authorization, CSRF, messages, live updates, read status, blocking, reports, pagination, restart persistence, and rate limits. The original Node implementation has a separate test suite: `npm test` with Node 24.

## Project layout

```text
COMA/
  server.py            Python server and API
  desktop.py           Desktop launcher
  schema.sql           SQLite schema
  public/              Browser interface and icon
  docs/screenshots/    Example screenshots
  test/                Python and legacy Node integration tests
  build.py             EXE / APP / DMG builder and self-test
  BUILDING.md          Desktop build instructions
  README.md
```

The original Node server (`server.mjs`) remains available. Python and Node use the same interface, database schema, and password hashes. Run only one server at a time against a database.

## Feedback

Describe what you did, what you expected, and what happened. Mention your operating system and whether you used the EXE or Python version. Do not share passwords, session cookies, invitation links, or personal databases in bug reports.
