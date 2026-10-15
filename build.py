"""Build on the destination OS: Windows EXE or macOS APP + DMG."""
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent


def main():
    if sys.platform not in ('win32', 'darwin'):
        raise SystemExit('Build the EXE on Windows or the DMG on macOS.')
    os.chdir(ROOT)
    os.environ['PYINSTALLER_CONFIG_DIR'] = str(ROOT / 'build' / 'pyinstaller-cache')
    command = [sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean',
               '--name', 'COMA', '--distpath', str(ROOT / 'dist'), '--workpath', str(ROOT / 'build'),
               '--specpath', str(ROOT / 'build'), '--add-data', f'{ROOT / "public"}{os.pathsep}public',
               '--add-data', f'{ROOT / "schema.sql"}{os.pathsep}.']
    if sys.platform == 'win32':
        command.append('--onefile')
    else:
        command += ['--windowed', '--onedir', '--osx-bundle-identifier', 'app.coma.desktop']
    command.append(str(ROOT / 'desktop.py'))
    subprocess.run(command, check=True)
    executable = ROOT / 'dist' / ('COMA.exe' if sys.platform == 'win32' else 'COMA.app/Contents/MacOS/COMA')
    with tempfile.TemporaryDirectory(prefix='coma-build-check-') as directory:
        result = Path(directory) / 'result.json'
        tested = subprocess.run([str(executable), '--self-test', str(result)], timeout=60)
        import json
        report = json.loads(result.read_text(encoding='utf-8'))
        if tested.returncode or not report.get('ok'):
            raise RuntimeError('Self-test failed: ' + report.get('error', str(tested.returncode)))
    if sys.platform == 'darwin':
        import shutil
        with tempfile.TemporaryDirectory(prefix='coma-dmg-') as directory:
            stage = Path(directory)
            shutil.copytree(ROOT / 'dist' / 'COMA.app', stage / 'COMA.app', symlinks=True)
            (stage / 'Applications').symlink_to('/Applications')
            dmg = ROOT / 'dist' / f'COMA-macOS-{platform.machine()}.dmg'
            subprocess.run(['hdiutil', 'create', '-volname', 'COMA', '-srcfolder', str(stage), '-ov', '-format', 'UDZO', str(dmg)], check=True)
            subprocess.run(['hdiutil', 'verify', str(dmg)], check=True)
            print(f'DMG built and verified: {dmg}')
    print(f'App built and self-test passed: {executable}')


if __name__ == '__main__':
    main()
