# COMA 2.0

**A place of your own for your people.**

COMA is a small chat app for one-to-one conversations. It runs locally with Python 3.12 or newer and stores accounts and messages in SQLite. Version 2.0 includes the browser interface and a working source download.

## Start

```sh
python server.py --open
```

On macOS or Linux, use `python3` if needed. Open http://127.0.0.1:4310 if your browser does not open automatically. Keep the server running while you use COMA. The first registered account becomes the administrator.

To chat with someone else, choose **Invite someone** and privately share the single-use link. It expires after seven days. The other person must reach the same server; a link with `127.0.0.1` only works on your own computer.

## Features

- Accounts with a username, display name, and password of at least 12 characters.
- Personal invitation links and private conversations between two people.
- Live messages, older message history, read status, and unread counts.
- Conversation search, contact blocking, and reports for the administrator.
- Responsive browser interface for desktop and mobile.

## Desktop builds

On Windows, install PyInstaller 6.22.3 and run `python build.py` to create `dist/COMA.exe`. On a Mac, the same command creates a COMA app and a DMG for that Mac's architecture. Read [BUILDING.md](BUILDING.md) for details. The Windows EXE was built and passed its bundled startup test. The macOS DMG has not yet been tested on a Mac. The source version is available on all supported platforms.

## Data and privacy

The default database is `data/coma.sqlite` beside the source code. Desktop builds use `%LOCALAPPDATA%\\COMA\\data` on Windows and `~/Library/Application Support/COMA/data` on macOS. Set `DATA_DIR` to choose another directory. Stop the server before backing up the complete data directory. The database and `.env` are excluded from Git.

Passwords use salted scrypt hashes. Sessions expire after seven days. The server limits sign-in and message attempts, and checks origin and CSRF tokens on write requests.

**Messages are not end-to-end encrypted and the database is not encrypted on disk.** The server administrator can read stored data. For access across devices, put a single COMA server behind HTTPS and set `PUBLIC_ORIGIN` to its exact origin and `COOKIE_SECURE=1`. The desktop launcher is for local use.

COMA 2.0 does not support password recovery, self-service account deletion or export, group conversations, calls, attachments, or push notifications. Drafts in the current browser window may be lost when it closes or reloads.

## Tests

```sh
python -m unittest discover -s test -p "test_*.py" -v
```

The smoke test starts an isolated temporary server and checks static assets, registration, invitation-only access, private messaging, and CSRF protection. The legacy Node server is available with Node 24; run `npm run check` to check its and the browser script's syntax. Do not run both servers against the same database at once.

## Project layout

```text
server.py          Python server and API
server.mjs         Legacy Node server
schema.sql         SQLite schema
public/            Browser interface
desktop.py         Desktop launcher
build.py           Desktop builder and bundled startup check
test/              Integration smoke test
```
