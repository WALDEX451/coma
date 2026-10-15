# Building COMA desktop apps

## Windows

Open `dist/COMA.exe`. Python is not needed on the destination computer. A console window starts the local server and opens COMA in your browser. Press Ctrl+C in the console to stop it. If port 4310 is already in use, close the other COMA server first.

New desktop data is stored in `%LOCALAPPDATA%\COMA\data`. The source version, started with `python server.py`, continues to use `data/` beside the source code. Desktop builds do not import source-version accounts automatically. The download contains code, runtime, and public app assets only.

To build on Windows, use Python 3.12 with PyInstaller:

```powershell
python -m pip install pyinstaller==6.22.3
python build.py
```

The builder tests the actual EXE: HTTP server, public assets, and empty database. Run integration tests with:

```powershell
python -m unittest discover -s test -p test_python.py -v
```

## macOS DMG

Build the macOS version on a Mac. Extract `COMA-macOS-source.zip` and open a terminal in the extracted directory. Use Python 3.12 or newer with Tkinter:

```sh
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install pyinstaller==6.22.3
python3 -m unittest discover -s test -p test_python.py -v
python3 build.py
```

This creates `dist/COMA.app`, tests the bundled app, creates `dist/COMA-macOS-arm64.dmg` or `dist/COMA-macOS-x86_64.dmg` depending on the build machine, and checks the DMG using `hdiutil verify`. Open the DMG and drag COMA into Applications. New data goes to `~/Library/Application Support/COMA/data`.

This configuration has no Apple Developer certificate or notarization. Signing and notarization must be set up before distributing an Apple-verified build. The DMG still needs to be built and opened on a real Mac.

## Data

`DATA_DIR` overrides the storage location. The build never includes that directory. Only `public/` and `schema.sql` are added as data files; accounts, password hashes, sessions, and messages are not included.
