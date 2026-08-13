#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Offline-tester för bin/claude-usage-update.

Kör skriptet som en riktig subprocess mot en lokal stubb av GitHub, med ett
HOME som pekar in i en temporär katalog — inga nätverksanrop utanför localhost
och ingenting som rör den riktiga installationen.

    python3 -m unittest tests.test_claude_usage_update -v
"""

from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UPDATER = os.path.join(REPO_ROOT, "bin", "claude-usage-update")

UUID = "claude-usage@hhammarstrand.github.io"
REPO = "testuser/testrepo"

OLD_SHA = "a" * 40
NEW_SHA = "b" * 40


def make_tarball(root_name, files, links=None):
    """-> bytes för en .tar.gz med de angivna filerna under root_name/."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, content in files.items():
            data = content.encode("utf-8")
            info = tarfile.TarInfo("%s/%s" % (root_name, name))
            info.size = len(data)
            info.mode = 0o755
            archive.addfile(info, io.BytesIO(data))
        for name, target in (links or {}).items():
            info = tarfile.TarInfo("%s/%s" % (root_name, name))
            info.type = tarfile.SYMTYPE
            info.linkname = target
            archive.addfile(info)
    return buffer.getvalue()


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler API
        server = self.server
        server.requests.append(self.path)
        status, content_type, body = server.responder(self.path)
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class StubGitHub:
    def __init__(self, responder):
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.httpd.responder = responder
        self.httpd.requests = []
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base(self):
        host, port = self.httpd.server_address[:2]
        return "http://%s:%d" % (host, port)

    @property
    def requests(self):
        return self.httpd.requests

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)


class UpdaterTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="claude-usage-update-test-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

        self.home = os.path.join(self.tmp, "home")
        self.ext_dir = os.path.join(
            self.home, ".local", "share", "gnome-shell", "extensions", UUID
        )
        os.makedirs(self.ext_dir)
        self.write_metadata(1)

        self.server = None
        # Markörfilen som den stubbade install.sh skriver, så att vi kan se att
        # den faktiskt kördes — och med vilken commit i miljön.
        self.marker = os.path.join(self.tmp, "installed.txt")

    def tearDown(self):
        if self.server:
            self.server.close()

    def write_metadata(self, version):
        with open(os.path.join(self.ext_dir, "metadata.json"), "w") as fh:
            json.dump({"uuid": UUID, "version": version}, fh)

    def write_stamp(self, sha):
        with open(os.path.join(self.ext_dir, ".installed-commit"), "w") as fh:
            fh.write(sha + "\n")

    def serve(self, responder):
        self.server = StubGitHub(responder)

    def default_responder(self, sha=NEW_SHA, installer=None, links=None):
        installer = installer or (
            '#!/bin/bash\nprintf "%s" "$CLAUDE_USAGE_INSTALL_COMMIT" > '
            + self.marker
            + "\necho installerat\n"
        )

        def responder(path):
            if path.startswith("/repos/"):
                return (
                    200,
                    "application/json",
                    json.dumps(
                        {"sha": sha, "commit": {"message": "Ny funktion\n\nDetaljer"}}
                    ),
                )
            if path.endswith(".tar.gz") or "/tar.gz/" in path:
                return (
                    200,
                    "application/gzip",
                    make_tarball(
                        "testrepo-%s" % sha[:7],
                        {"install.sh": installer, "README.md": "hej"},
                        links,
                    ),
                )
            return 404, "text/plain", "nope"

        return responder

    def run_updater(self, *args):
        env = dict(os.environ)
        env.update(
            {
                "HOME": self.home,
                "CLAUDE_USAGE_REPO": REPO,
                "CLAUDE_USAGE_API_BASE": self.server.base if self.server else "http://127.0.0.1:1",
                "CLAUDE_USAGE_CODELOAD_BASE": self.server.base if self.server else "http://127.0.0.1:1",
            }
        )
        result = subprocess.run(
            [sys.executable, UPDATER, *args],
            capture_output=True,
            text=True,
            timeout=90,
            env=env,
        )
        return result

    def json_of(self, result):
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError:
            self.fail("utdata var inte JSON:\n%s\n%s" % (result.stdout, result.stderr))


class TestCheck(UpdaterTestCase):
    def test_reports_update_when_sha_differs(self):
        self.write_stamp(OLD_SHA)
        self.serve(self.default_responder())
        payload = self.json_of(self.run_updater("--check"))

        self.assertTrue(payload["ok"])
        self.assertTrue(payload["update_available"])
        self.assertEqual(payload["installed_commit"], OLD_SHA)
        self.assertEqual(payload["latest_commit"], NEW_SHA)
        # Bara första raden ur commit-meddelandet, inte hela kroppen.
        self.assertEqual(payload["latest_summary"], "Ny funktion")

    def test_no_update_when_sha_matches(self):
        self.write_stamp(NEW_SHA)
        self.serve(self.default_responder())
        payload = self.json_of(self.run_updater("--check"))
        self.assertFalse(payload["update_available"])
        self.assertFalse(payload["unknown_installed"])

    def test_missing_stamp_does_not_claim_an_update(self):
        """Utan stämpel vet vi ingenting — då är en gissning värre än tystnad."""
        self.serve(self.default_responder())
        payload = self.json_of(self.run_updater("--check"))
        self.assertFalse(payload["update_available"])
        self.assertTrue(payload["unknown_installed"])
        self.assertIsNone(payload["installed_commit"])

    def test_check_downloads_nothing(self):
        self.write_stamp(OLD_SHA)
        self.serve(self.default_responder())
        self.run_updater("--check")
        self.assertTrue(all("tar.gz" not in path for path in self.server.requests),
                        "--check får inte hämta någon kod")

    def test_version_makes_no_request(self):
        self.write_stamp(OLD_SHA)
        self.serve(self.default_responder())
        payload = self.json_of(self.run_updater("--version"))
        self.assertEqual(payload["installed_commit"], OLD_SHA)
        self.assertEqual(payload["installed_version"], 1)
        self.assertEqual(self.server.requests, [])

    def test_corrupt_stamp_is_ignored(self):
        with open(os.path.join(self.ext_dir, ".installed-commit"), "w") as fh:
            fh.write("inte en sha\n")
        self.serve(self.default_responder())
        payload = self.json_of(self.run_updater("--check"))
        self.assertIsNone(payload["installed_commit"])
        self.assertTrue(payload["unknown_installed"])


class TestApply(UpdaterTestCase):
    def test_apply_runs_the_downloaded_installer(self):
        self.write_stamp(OLD_SHA)
        self.serve(self.default_responder())
        result = self.run_updater("--apply")
        payload = self.json_of(result)

        self.assertTrue(payload["ok"], payload)
        self.assertTrue(payload["updated"])
        self.assertTrue(payload["logout_required"],
                        "Shell laddar bara tillägg vid uppstart")
        self.assertEqual(payload["installed_commit"], NEW_SHA)
        self.assertTrue(os.path.exists(self.marker), "install.sh kördes inte")
        with open(self.marker) as fh:
            self.assertEqual(fh.read(), NEW_SHA,
                             "install.sh ska få commiten i miljön för stämpeln")

    def test_apply_is_a_noop_when_already_current(self):
        self.write_stamp(NEW_SHA)
        self.serve(self.default_responder())
        payload = self.json_of(self.run_updater("--apply"))
        self.assertFalse(payload["updated"])
        self.assertEqual(payload["reason"], "already_current")
        self.assertFalse(os.path.exists(self.marker))
        self.assertTrue(all("tar.gz" not in p for p in self.server.requests))

    def test_failing_installer_is_reported_not_swallowed(self):
        self.write_stamp(OLD_SHA)
        self.serve(self.default_responder(
            installer="#!/bin/bash\necho 'det small'\nexit 3\n"))
        result = self.run_updater("--apply")
        payload = self.json_of(result)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["kind"], "install_failed")
        self.assertEqual(result.returncode, 1)

    def test_archive_without_installer_is_rejected(self):
        self.write_stamp(OLD_SHA)

        def responder(path):
            if path.startswith("/repos/"):
                return 200, "application/json", json.dumps(
                    {"sha": NEW_SHA, "commit": {"message": "x"}})
            return 200, "application/gzip", make_tarball(
                "testrepo-x", {"README.md": "bara en readme"})

        self.serve(responder)
        payload = self.json_of(self.run_updater("--apply"))
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["kind"], "bad_archive")

    def test_symlink_in_archive_is_refused(self):
        """En länk i arkivet kan peka var som helst — packa inte upp den."""
        self.write_stamp(OLD_SHA)
        self.serve(self.default_responder(
            links={"evil": "/etc/passwd"}))
        payload = self.json_of(self.run_updater("--apply"))
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["kind"], "bad_archive")
        self.assertFalse(os.path.exists(self.marker), "inget fick köras")


class TestResilience(UpdaterTestCase):
    def test_network_error_is_reported_as_json(self):
        # Ingen server startad -> anslutningen vägras.
        result = self.run_updater("--check")
        payload = self.json_of(result)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["kind"], "network_error")
        self.assertEqual(result.returncode, 1)

    def test_html_response_is_not_mistaken_for_json(self):
        self.serve(lambda path: (200, "text/html", "<html>hej</html>"))
        payload = self.json_of(self.run_updater("--check"))
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["kind"], "bad_response")

    def test_rate_limit_has_its_own_kind(self):
        self.serve(lambda path: (403, "application/json", "{}"))
        payload = self.json_of(self.run_updater("--check"))
        self.assertEqual(payload["error"]["kind"], "rate_limited")

    def test_garbage_sha_is_rejected(self):
        self.serve(lambda path: (200, "application/json", json.dumps({"sha": "nej"})))
        payload = self.json_of(self.run_updater("--check"))
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["kind"], "bad_response")

    def test_output_is_always_json(self):
        for args in (["--check"], ["--apply"], ["--version"]):
            with self.subTest(args=args):
                result = self.run_updater(*args)
                json.loads(result.stdout)


class TestCliContract(UpdaterTestCase):
    def test_executable_with_python3_shebang(self):
        self.assertTrue(os.access(UPDATER, os.X_OK), "ska vara körbar")
        with open(UPDATER, encoding="utf-8") as fh:
            self.assertEqual(fh.readline().strip(), "#!/usr/bin/env python3")

    def test_stdlib_only(self):
        with open(UPDATER, encoding="utf-8") as fh:
            source = fh.read()
        for line in source.splitlines():
            if line.startswith(("import ", "from ")) and "__future__" not in line:
                module = line.split()[1].split(".")[0]
                self.assertIn(
                    module,
                    sys.stdlib_module_names,
                    "%s ligger utanför stdlib" % module,
                )

    def test_plain_http_source_is_refused(self):
        """Uppdateraren hämtar kod som körs — bara https, utom mot loopback."""
        env = dict(os.environ)
        env.update(
            {
                "HOME": self.home,
                "CLAUDE_USAGE_REPO": REPO,
                "CLAUDE_USAGE_API_BASE": "http://example.invalid",
                "CLAUDE_USAGE_CODELOAD_BASE": "http://example.invalid",
            }
        )
        result = subprocess.run(
            [sys.executable, UPDATER, "--check"],
            capture_output=True, text=True, timeout=60, env=env,
        )
        payload = json.loads(result.stdout)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["kind"], "insecure_source")

    def test_modes_are_mutually_exclusive(self):
        self.serve(self.default_responder())
        result = self.run_updater("--check", "--apply")
        self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
