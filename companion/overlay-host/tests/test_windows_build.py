"""The installer build's code-signing switch (packaging/windows/build.py)."""
import importlib.util
from pathlib import Path
import unittest
from unittest import mock

BUILD_PY = Path(__file__).resolve().parents[1] / 'packaging' / 'windows' / 'build.py'


def load_build(sign_command):
    with mock.patch.dict('os.environ', {'KEYBARD_SIGN_COMMAND': sign_command}):
        spec = importlib.util.spec_from_file_location('keybard_windows_build', BUILD_PY)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module


class SigningSwitchTests(unittest.TestCase):
    def test_unsigned_when_not_configured(self):
        build = load_build('')
        with mock.patch.object(build.subprocess, 'run') as run, mock.patch.object(build, 'find_iscc', return_value=Path('ISCC.exe')):
            self.assertFalse(build.sign(Path('C:/app/Keybard Host.exe')))
            build.installer(Path('C:/app'), Path('C:/p.html'), '0.1.0-preview.6')
        iscc = run.call_args_list[-1].args[0]
        self.assertFalse(any(a == '/DSign' or a.startswith('/S') for a in iscc))
        self.assertIn('/DNumericVersion=0.1.0.6', iscc)

    def test_signs_app_installer_and_uninstaller_and_verifies(self):
        build = load_build('signtool sign /fd SHA256 /tr http://ts.example /td SHA256 {file}')
        with mock.patch.object(build.subprocess, 'run') as run, mock.patch.object(build, 'find_iscc', return_value=Path('ISCC.exe')):
            self.assertTrue(build.sign(Path('C:/app/Keybard Host.exe')))
            build.installer(Path('C:/app'), Path('C:/p.html'), '0.1.0')
        calls = [c.args[0] for c in run.call_args_list]
        self.assertEqual(calls[0], f'signtool sign /fd SHA256 /tr http://ts.example /td SHA256 "{Path("C:/app/Keybard Host.exe")}"')
        self.assertIn('Get-AuthenticodeSignature', calls[1][-1])
        iscc = calls[2]
        self.assertIn('/DSign', iscc)
        self.assertIn('/Skeybard=signtool sign /fd SHA256 /tr http://ts.example /td SHA256 $f', iscc)
        self.assertIn('KeybardHostSetup.exe', calls[3][-1])  # installer signature verified

    def test_quotes_in_the_command_reach_inno_as_q(self):
        build = load_build(r'"C:\Program Files (x86)\Windows Kits\signtool.exe" sign /fd SHA256 {file}')
        with mock.patch.object(build.subprocess, 'run') as run, mock.patch.object(build, 'find_iscc', return_value=Path('ISCC.exe')):
            build.installer(Path('C:/app'), Path('C:/p.html'), '0.1.0')
        iscc = run.call_args_list[0].args[0]
        sign_arg = next(a for a in iscc if a.startswith('/Skeybard='))
        self.assertNotIn('"', sign_arg)  # ISCC fails on escaped quotes
        self.assertEqual(sign_arg, r'/Skeybard=$qC:\Program Files (x86)\Windows Kits\signtool.exe$q sign /fd SHA256 $f')

    def test_command_must_name_the_file(self):
        build = load_build('signtool sign /fd SHA256')
        with self.assertRaises(SystemExit): build.sign(Path('C:/x.exe'))


if __name__ == '__main__':
    unittest.main()
