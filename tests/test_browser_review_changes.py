import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'browser_review_changes.py'
spec = importlib.util.spec_from_file_location('browser_review_changes', SCRIPT)
changes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(changes)


def git(cwd, *args):
    return subprocess.run(['git', *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


class BrowserReviewChangesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.remote = root / 'remote.git'
        self.repo = root / 'repo'
        self.state = root / 'state'
        self.state.mkdir()
        git(root, 'init', '--bare', '-q', str(self.remote))
        git(root, 'init', '-q', '-b', 'main', str(self.repo))
        (self.repo / 'src').mkdir()
        (self.repo / 'src' / 'example.js').write_text('const value = 1;\n')
        git(self.repo, 'add', '.')
        git(self.repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'baseline')
        git(self.repo, 'remote', 'add', 'origin', str(self.remote))
        git(self.repo, 'push', '-q', 'origin', 'main')
        self.report = '评审建议'.encode()
        self.branch = 'browser-eval/fixes-2026-11-26'
        self.number = 42
        self.url = 'https://example.test/pull/42'
        self.pr_created = False
        self.ask_calls = []

    def github(self, *args):
        endpoint = args[-1] if len(args) == 1 else args[2]
        if '?state=all' in endpoint:
            return [self.pr()] if self.pr_created else []
        if args[0] == '--method':
            self.pr_created = True
            return self.pr()
        if '/compare/' in endpoint:
            return {'status': 'identical'}
        return self.pr()

    def pr(self):
        sha = git(self.remote, 'rev-parse', 'refs/heads/' + self.branch)
        return {'number': self.number, 'state': 'open', 'head': {'ref': self.branch, 'sha': sha}, 'html_url': self.url}

    def ask(self, state, name, prompt, properties, model):
        self.ask_calls.append(name)
        if name == 'select-files':
            return {'files': ['src/example.js']}
        return {'summary': '已更新；待 CI 验证。', 'blocked': False, 'edits': [
            {'path': 'src/example.js', 'before': 'value = 1', 'after': 'value = 2'}]}

    def prepare(self, previous=None):
        with patch.object(changes, 'REMOTE', str(self.remote)), patch.object(changes, 'gh', side_effect=self.github), patch.object(changes, 'ask', side_effect=self.ask):
            return changes.prepare('2026-11-26', self.state, self.report, None, previous)

    def test_creates_change_and_reuses_previous_receipt(self):
        result = self.prepare()
        self.assertEqual(self.ask_calls, ['select-files', 'implement'])
        self.assertEqual(result['reviewSha256'], hashlib.sha256(self.report).hexdigest())
        self.assertEqual(result['number'], self.number)
        self.assertEqual(result['url'], self.url)
        self.assertEqual(git(self.remote, 'show', self.branch + ':src/example.js'), 'const value = 2;')
        self.assertIn('Browser-Review-SHA256: ' + result['reviewSha256'], git(self.remote, 'log', '-1', '--format=%B', self.branch))
        self.assertEqual(json.loads((self.state / 'changes.json').read_text()), result)

        (self.state / 'changes.json').unlink()
        self.ask_calls.clear()
        self.assertEqual(self.prepare(previous=result), result)
        self.assertEqual(self.ask_calls, [])
        self.assertEqual(json.loads((self.state / 'changes.json').read_text()), result)

    def test_retry_after_push_reuses_summary_and_commit(self):
        original = self.github
        def fail_create(*args):
            if args[0] == '--method':
                raise RuntimeError('temporary GitHub failure')
            return original(*args)
        with patch.object(changes, 'REMOTE', str(self.remote)), patch.object(changes, 'gh', side_effect=fail_create), patch.object(changes, 'ask', side_effect=self.ask):
            with self.assertRaisesRegex(RuntimeError, 'temporary GitHub failure'):
                changes.prepare('2026-11-26', self.state, self.report, None)
        commit = git(self.remote, 'rev-parse', 'refs/heads/' + self.branch)
        self.ask_calls.clear()
        result = self.prepare()
        self.assertEqual(result['commit'], commit)
        self.assertEqual(self.ask_calls, [])
        self.assertEqual(json.loads((self.state / 'changes.json').read_text()), result)


if __name__ == '__main__':
    unittest.main()
