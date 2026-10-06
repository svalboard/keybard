"""Build the Keybard Host Windows installer.

Freezes the host with PyInstaller (Python, Qt and both Keybard builds included,
so nothing is downloaded on first run), then packages it with Inno Setup into
build-windows/KeybardHostSetup.exe.

Run from the repository root after `npm run build:svalboard` and
`npm run build:paranoid`, with the packages in requirements.txt and PyInstaller
installed, and Inno Setup 6 available.
"""
import argparse
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
HOST = HERE.parents[1]
ROOT = HOST.parents[1]
BUILD = ROOT / 'build-windows'
ICON = HOST / 'keybard_host' / 'assets' / 'svalboard.ico'
# Code signing is off until configured (docs/code-signing.md). KEYBARD_SIGN_COMMAND is a
# command line containing {file}; it is run once for each file to sign.
SIGN_COMMAND = os.environ.get('KEYBARD_SIGN_COMMAND', '').strip()


def find_iscc():
    found = shutil.which('iscc')
    if found: return Path(found)
    for base in (os.environ.get('ProgramFiles(x86)'), os.environ.get('ProgramFiles'), os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Programs')):
        if base and (Path(base) / 'Inno Setup 6' / 'ISCC.exe').is_file():
            return Path(base) / 'Inno Setup 6' / 'ISCC.exe'
    raise SystemExit('Inno Setup 6 (ISCC.exe) was not found.')


def verify_signature(path):
    """Fail the build unless Windows reports a valid, timestamped signature."""
    literal = str(path).replace("'", "''")
    script = (f"$s = Get-AuthenticodeSignature -LiteralPath '{literal}'; "
              "if ($s.Status -ne 'Valid') { Write-Error \"$($s.Status): $($s.StatusMessage)\"; exit 1 }; "
              "if (-not $s.TimeStamperCertificate) { Write-Error 'Signature is not timestamped'; exit 1 }; "
              "Write-Output \"signed: $($s.SignerCertificate.Subject)\"")
    # Windows PowerShell 5.1 can't load its own modules with PowerShell 7's PSModulePath
    # (inherited when the build runs under pwsh, as in CI), so let it use its default.
    env = {k: v for k, v in os.environ.items() if k.upper() != 'PSMODULEPATH'}
    subprocess.run(['powershell.exe', '-NoProfile', '-Command', script], check=True, env=env)


def sign(path):
    if not SIGN_COMMAND: return False
    if '{file}' not in SIGN_COMMAND: raise SystemExit('KEYBARD_SIGN_COMMAND must contain {file}')
    subprocess.run(SIGN_COMMAND.replace('{file}', f'"{path}"'), shell=True, check=True)
    verify_signature(path)
    return True


def stage():
    """Lay out the web assets exactly where the host looks for them (next to its package)."""
    dist, paranoid = ROOT / 'dist', ROOT / 'dist-paranoid' / 'keybard-paranoid.html'
    if not (dist / 'index.html').is_file(): raise SystemExit('Run `npm run build:svalboard` first.')
    if not paranoid.is_file(): raise SystemExit('Run `npm run build:paranoid` first.')
    target = BUILD / 'stage'
    shutil.rmtree(target, ignore_errors=True)
    shutil.copytree(dist, target / 'web', ignore=shutil.ignore_patterns('*.zip', 'SHA256SUMS.txt', 'keybard-paranoid.html'))
    (target / 'web-paranoid').mkdir(parents=True)
    page = paranoid.read_bytes()
    (target / 'web-paranoid' / 'index.html').write_bytes(page)
    (target / 'web-paranoid' / 'SHA256SUMS.txt').write_text(f'{hashlib.sha256(page).hexdigest()}  index.html\n', encoding='utf-8')
    return target, paranoid


def freeze(staged):
    data = [(staged / 'web', 'web'), (staged / 'web-paranoid', 'web-paranoid'), (HOST / 'keybard_host' / 'assets', 'keybard_host/assets')]
    command = [sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--windowed',
               '--name', 'Keybard Host', '--icon', str(ICON), '--paths', str(HOST), '--hidden-import', 'hid',
               '--distpath', str(BUILD / 'dist'), '--workpath', str(BUILD / 'work'), '--specpath', str(BUILD)]
    for source, dest in data: command += ['--add-data', f'{source}{os.pathsep}{dest}']
    subprocess.run(command + [str(HERE / 'keybard_host_app.py')], check=True)
    app = BUILD / 'dist' / 'Keybard Host'
    for required in ('Keybard Host.exe', '_internal/web/index.html', '_internal/web-paranoid/index.html', '_internal/keybard_host/assets/svalboard.png'):
        if not (app / required).is_file(): raise SystemExit(f'Frozen app is missing {required}')
    sign(app / 'Keybard Host.exe')
    return app


def installer(app, paranoid, version):
    numeric = '.'.join((re.findall(r'\d+', version) + ['0'] * 4)[:4])
    command = [str(find_iscc()), f'/DAppVersion={version}', f'/DNumericVersion={numeric}', f'/DSourceDir={app}',
               f'/DParanoidFile={paranoid}', f'/DIconFile={ICON}', f'/DOutputDir={BUILD}']
    if SIGN_COMMAND:
        # Inno Setup signs the installer and the uninstaller it generates; $f is the quoted file.
        # ISCC can't parse escaped quotes on its command line; Inno's sign-tool syntax
        # spells a quote as $q (and the quoted file name as $f).
        command += ['/DSign', '/Skeybard=' + SIGN_COMMAND.replace('"', '$q').replace('{file}', '$f')]
    subprocess.run(command + [str(HERE / 'KeybardHost.iss')], check=True)
    setup = BUILD / 'KeybardHostSetup.exe'
    if SIGN_COMMAND: verify_signature(setup)
    else: print('Not code signed: KEYBARD_SIGN_COMMAND is not set (see docs/code-signing.md).')
    return setup


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', default='0.0.0-dev', help='version or keybard-host-v* tag')
    parser.add_argument('--freeze-only', action='store_true', help='skip the Inno Setup step')
    args = parser.parse_args()
    version = args.version.removeprefix('keybard-host-v')
    staged, paranoid = stage()
    app = freeze(staged)
    print(app if args.freeze_only else installer(app, paranoid, version))


if __name__ == '__main__':
    main()
