"""Desktop launcher; packaged builds contain code/assets, never account data."""
import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import tkinter as tk
from tkinter import messagebox, ttk
from urllib.request import urlopen
import webbrowser

from server import App


def data_directory():
    if os.getenv('DATA_DIR'):
        return Path(os.environ['DATA_DIR']).resolve()
    if sys.platform == 'win32':
        base = Path(os.getenv('LOCALAPPDATA', Path.home() / 'AppData' / 'Local'))
    elif sys.platform == 'darwin':
        base = Path.home() / 'Library' / 'Application Support'
    else:
        base = Path(os.getenv('XDG_DATA_HOME', Path.home() / '.local' / 'share'))
    return base / 'COMA' / 'data'


def self_test(output):
    """Exercise the actual bundled server/assets without changing user data."""
    with tempfile.TemporaryDirectory(prefix='coma-check-') as directory:
        app = App(('127.0.0.1', 0), directory)
        thread = threading.Thread(target=app.serve_forever, daemon=True)
        thread.start()
        try:
            base = f'http://127.0.0.1:{app.server_port}'
            for path in ('/', '/app.js', '/styles.css', '/favicon.svg'):
                with urlopen(base + path, timeout=5) as response:
                    assert response.status == 200 and response.read()
            with urlopen(base + '/api/session', timeout=5) as response:
                assert json.load(response)['setup'] is True
            checks = ['http', 'assets', 'empty-database']
            if sys.platform == 'darwin':
                window = tk.Tk()
                window.withdraw()
                window.update()
                window.destroy()
                checks.append('tkinter')
            Path(output).write_text(json.dumps({'ok': True, 'checks': checks}), encoding='utf-8')
        finally:
            app.shutdown()
            app.server_close()
            thread.join()
            app.db.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--self-test', metavar='RESULT_JSON')
    args = parser.parse_args()
    if args.self_test:
        try:
            self_test(args.self_test)
        except Exception:
            import traceback
            Path(args.self_test).write_text(json.dumps({'ok': False, 'error': traceback.format_exc()}), encoding='utf-8')
            sys.exit(1)
        return
    if sys.platform != 'darwin':
        os.environ['DATA_DIR'] = str(data_directory())
        from server import main as server_main
        sys.argv = [sys.argv[0], '--open']
        server_main()
        return
    window = tk.Tk()
    window.title('COMA')
    window.geometry('460x230')
    window.resizable(False, False)
    try:
        app = App(('127.0.0.1', int(os.getenv('PORT', '4310'))), data_directory())
    except Exception as error:
        messagebox.showerror('COMA could not start', f'{error}\n\nClose any COMA server already running and try again.', parent=window)
        window.destroy()
        return
    thread = threading.Thread(target=app.serve_forever, daemon=True)
    thread.start()
    url = f'http://127.0.0.1:{app.server_port}'
    frame = ttk.Frame(window, padding=24)
    frame.pack(fill='both', expand=True)
    ttk.Label(frame, text='COMA', font=('', 24, 'bold')).pack(anchor='w')
    ttk.Label(frame, text='A place of your own for your people.').pack(anchor='w', pady=(4, 14))
    ttk.Label(frame, text='COMA is running locally. Close this window to stop it.').pack(anchor='w')
    ttk.Button(frame, text='Open COMA', command=lambda: webbrowser.open(url)).pack(anchor='w', pady=18)

    def close():
        app.shutdown()
        app.server_close()
        thread.join(timeout=5)
        with app.lock:
            app.db.close()
        window.destroy()

    window.protocol('WM_DELETE_WINDOW', close)
    window.after(250, lambda: webbrowser.open(url))
    window.mainloop()


if __name__ == '__main__':
    main()
