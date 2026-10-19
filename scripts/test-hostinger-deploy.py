#!/usr/bin/env python3
"""Exercise deployment boundaries with fake Docker; never touches the VPS."""
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / 'deploy/hostinger-receive.sh'
SHA = 'a' * 40
PAYLOAD = b'test-image'


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'deploy').mkdir()
        (self.root / 'bin').mkdir()
        (self.root / '.env').touch()
        (self.root / '.env.runtime').touch()
        (self.root / 'deploy/docker-compose.hostinger.yml').touch()
        self.log = self.root / 'calls'
        self.env = dict(os.environ, CONVO_DEPLOY_ROOT=str(self.root),
                        CALLS=str(self.log), REVISION=SHA,
                        PATH=str(self.root / 'bin') + ':' + os.environ['PATH'])
        self.executable('bin/docker', '''#!/bin/bash
echo "docker $*" >> "$CALLS"
case "$*" in
  'image inspect '*) echo "$REVISION" ;;
  'inspect convo-api-1 '*) echo sha256:previous ;;
  *' up '*) exit "${UP_EXIT:-0}" ;;
esac
''')
        self.executable('bin/curl', '#!/bin/sh\necho curl >> "$CALLS"\nexit "${CURL_EXIT:-0}"\n')
        self.executable('deploy/backup.sh', '#!/bin/sh\necho backup >> "$CALLS"\nexit "${BACKUP_EXIT:-0}"\n')

    def executable(self, name, source):
        path = self.root / name
        path.write_text(source)
        path.chmod(0o700)

    def run_deploy(self, command=None, **env):
        command = command or f'deploy {SHA} {hashlib.sha256(PAYLOAD).hexdigest()}'
        return subprocess.run(['bash', str(SCRIPT)], input=PAYLOAD,
                              env=dict(self.env, SSH_ORIGINAL_COMMAND=command, **env),
                              capture_output=True, timeout=10)

    def calls(self):
        return self.log.read_text() if self.log.exists() else ''

    def test_success_orders_backup_before_stopping_and_records_release(self):
        result = self.run_deploy()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        calls = self.calls()
        self.assertLess(calls.index('backup'), calls.index(' stop '))
        self.assertIn('--wait --wait-timeout 180', calls)
        self.assertIn(f'CONVO_IMAGE=convo:{SHA}', (self.root / '.release.env').read_text())
        self.assertEqual((self.root / '.deploy/previous-image').read_text().strip(), 'sha256:previous')
        self.assertEqual(list((self.root / '.deploy').glob('image.*')), [])

    def test_rejects_shell_commands(self):
        result = self.run_deploy(f'deploy {SHA} {"b" * 64}; touch injected')
        self.assertEqual(result.returncode, 64)
        self.assertEqual(self.calls(), '')

    def test_check_does_not_load_or_stop(self):
        self.assertEqual(self.run_deploy('check').returncode, 0)
        self.assertNotIn('docker load', self.calls())
        self.assertNotIn(' stop ', self.calls())

    def test_checksum_failure_never_loads_or_stops(self):
        self.assertNotEqual(self.run_deploy(f'deploy {SHA} {"b" * 64}').returncode, 0)
        self.assertNotIn('docker load', self.calls())
        self.assertNotIn(' stop ', self.calls())

    def test_wrong_image_revision_never_stops(self):
        self.assertNotEqual(self.run_deploy(REVISION='b' * 40).returncode, 0)
        self.assertNotIn('backup', self.calls())
        self.assertNotIn(' stop ', self.calls())

    def test_backup_failure_leaves_running_services_untouched(self):
        self.assertNotEqual(self.run_deploy(BACKUP_EXIT='1').returncode, 0)
        self.assertNotIn(' stop ', self.calls())

    def test_start_failure_does_not_claim_success_or_restore_database(self):
        self.assertNotEqual(self.run_deploy(UP_EXIT='1').returncode, 0)
        self.assertFalse((self.root / '.release.env').exists())
        self.assertIn('FAILED', (self.root / '.deploy/last-attempt').read_text())
        self.assertNotIn('pg_restore', self.calls())

    def test_smoke_failure_preserves_previous_release_record(self):
        (self.root / '.release.env').write_text('CONVO_IMAGE=convo:previous\n')
        self.assertNotEqual(self.run_deploy(CURL_EXIT='1').returncode, 0)
        self.assertEqual((self.root / '.release.env').read_text(), 'CONVO_IMAGE=convo:previous\n')
        self.assertIn('phase=smoke', (self.root / '.deploy/last-attempt').read_text())


if __name__ == '__main__':
    unittest.main()
