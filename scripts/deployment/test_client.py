import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import client


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / ".env").write_text(
            "DEPLOY_HOST=host.example\nDEPLOY_USER=bleu\nUNRELATED_SECRET=do-not-read\n"
        )

    def test_sync_both_directions_preserves_destination_only_files(self):
        (self.root / "env").mkdir()
        with (
            patch.object(client, "ROOT", self.root),
            patch.dict(os.environ, {}, clear=True),
            patch.object(client.subprocess, "run") as run,
        ):
            for mode in ("push-secrets", "pull-secrets"):
                with patch.object(client.sys, "argv", ["client.py", mode]):
                    client.main()
                arguments = run.call_args.args[0]
                self.assertEqual(arguments[0], "rsync")
                self.assertNotIn("--delete", arguments)
                self.assertIn("--safe-links", arguments)

    def test_connection_config_is_data_not_executable_shell(self):
        (self.root / ".env").write_text(
            "DEPLOY_HOST=$(touch /tmp/should-never-exist)\nDEPLOY_USER=bleu\n"
        )
        with (
            patch.object(client, "ROOT", self.root),
            patch.dict(os.environ, {}, clear=True),
            self.assertRaises(ValueError),
        ):
            client.connection()

    def test_ci_values_do_not_need_local_dotenv_file(self):
        (self.root / ".env").unlink()
        with (
            patch.object(client, "ROOT", self.root),
            patch.dict(
                os.environ,
                {"DEPLOY_HOST": "host.example", "DEPLOY_USER": "bleu"},
                clear=True,
            ),
        ):
            self.assertEqual(
                client.connection(), ("bleu@host.example", "/home/bleu/byos-service-ts")
            )


if __name__ == "__main__":
    unittest.main()
