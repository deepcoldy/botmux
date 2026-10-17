"""Configuration boundaries; no model calls, server starts, or live Bot mutations."""

import argparse
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("memory_pilot", Path(__file__).with_name("pilot.py"))
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)


class PilotConfigurationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        self.root = self.home / "example"
        (self.root / "bin").mkdir(parents=True)
        (self.root / "bin/codex-openviking").write_text("placeholder")
        codex_home = self.home / ".codex"
        codex_home.mkdir()
        (codex_home / "config.toml").write_text('model = "test-model"\n')
        self.codex = self.home / "codex"
        self.codex.write_text("#!/usr/bin/env python3\nimport sys\nprint('codex-cli 0.160.1' if '--version' in sys.argv else '--no-daemon')\n")
        self.codex.chmod(0o755)
        self.botmux_root = self.home / "botmux-package"
        self.botmux_root.mkdir()
        (self.botmux_root / "package.json").write_text('{"name":"botmux"}')
        self.bots_path = self.home / "custom-bots.json"
        self.bots = [
            {"larkAppId": "cli_other", "cliId": "claude", "allowedUsers": ["owner-other"]},
            {"larkAppId": "cli_selected", "cliId": "codex", "allowedUsers": ["owner-selected"]},
            {"larkAppId": "cli_codex_other", "cliId": "codex", "allowedUsers": ["owner-third"]},
        ]
        self.bots_path.write_text(json.dumps(self.bots))
        self.addCleanup(patch.stopall)
        patch.multiple(pilot, ROOT=self.root, USER_ROOT=self.home,
                       OV_ROOT=self.home / ".openviking", BOT_ROOT=self.home / ".botmux",
                       VENV=self.home / "venv").start()
        patch.dict(os.environ, {"PATH": os.environ.get("PATH", "")}, clear=True).start()
        self.output = contextlib.redirect_stdout(io.StringIO())
        self.output.__enter__()
        self.addCleanup(self.output.__exit__, None, None, None)

    def configure(self, **overrides):
        values = dict(bot_index=1, bots_config=str(self.bots_path), codex=str(self.codex),
                      botmux_root=str(self.botmux_root), pm2=None, vlm_model=None,
                      memory_user="shared-owner", use_existing_server=False)
        values.update(overrides)
        pilot.configure(argparse.Namespace(**values))

    def test_default_requires_explicit_selection_and_does_not_write(self):
        before = self.bots_path.read_bytes()
        with self.assertRaisesRegex(SystemExit, "--bot-index explicitly"):
            self.configure(bot_index=None)
        self.assertEqual(self.bots_path.read_bytes(), before)
        self.assertFalse((self.root / "runtime.json").exists())
        self.assertFalse(pilot.OV_ROOT.exists())

    def test_configure_leaves_bots_and_global_codex_plugin_disabled(self):
        before = self.bots_path.read_bytes()
        codex_before = (self.home / ".codex/config.toml").read_bytes()
        self.configure()
        self.assertEqual(self.bots_path.read_bytes(), before)
        self.assertEqual((self.home / ".codex/config.toml").read_bytes(), codex_before)
        runtime = pilot.load_runtime()
        self.assertEqual(runtime["bot_app_id"], "cli_selected")
        self.assertEqual(runtime["bots_config"], str(self.bots_path))
        self.assertEqual((self.root / "runtime.json").stat().st_mode & 0o777, 0o600)
        server = json.loads((pilot.OV_ROOT / "ov.conf").read_text())
        self.assertEqual(server["embedding"]["dense"]["dimension"], 512)
        client = json.loads(Path(runtime["client_config"]).read_text())
        settings = client["plugin"]["codex"]
        self.assertFalse(settings["autoRecall"])
        self.assertTrue(settings["noAutoInject"])
        self.assertFalse(settings["resumeArchiveInject"])

    def test_bind_and_unbind_preserve_other_bots_and_later_updates(self):
        self.configure()
        pilot.bind()
        bound = json.loads(self.bots_path.read_text())
        self.assertEqual(bound[0], self.bots[0])
        self.assertEqual(bound[2], self.bots[2])
        self.assertEqual(bound[1]["cliPathOverride"], str(self.root / "bin/codex-openviking"))
        bound[0]["description"] = "updated after binding"
        self.bots_path.write_text(json.dumps(bound))
        pilot.unbind()
        restored = json.loads(self.bots_path.read_text())
        self.assertEqual(restored[1], self.bots[1])
        self.assertEqual(restored[0]["description"], "updated after binding")
        self.assertEqual(restored[2], self.bots[2])

    def test_reconfigure_preserves_shared_credentials_and_other_agent_settings(self):
        self.configure()
        path = Path(pilot.load_runtime()["client_config"])
        client = json.loads(path.read_text())
        client.update(account="shared-account", api_key_env="SHARED_MEMORY_API_KEY")
        client["plugin"]["other_agent"] = {"setting": "preserved"}
        path.write_text(json.dumps(client))
        self.configure(memory_user=None)
        current = json.loads(path.read_text())
        self.assertEqual(current["account"], "shared-account")
        self.assertEqual(current["api_key_env"], "SHARED_MEMORY_API_KEY")
        self.assertEqual(current["plugin"]["other_agent"], {"setting": "preserved"})
        self.assertEqual(current["user"], "shared-owner")

    def test_binding_refuses_changed_user_boundary_and_existing_wrapper(self):
        self.configure()
        bots = json.loads(self.bots_path.read_text())
        bots[1]["allowedUsers"].append("another-owner")
        self.bots_path.write_text(json.dumps(bots))
        before = self.bots_path.read_bytes()
        with self.assertRaisesRegex(SystemExit, "exactly one allowed user"):
            pilot.bind()
        self.assertEqual(self.bots_path.read_bytes(), before)
        bots[1]["allowedUsers"] = ["owner-selected"]
        bots[1]["cliPathOverride"] = "/custom/existing-wrapper"
        self.bots_path.write_text(json.dumps(bots))
        before = self.bots_path.read_bytes()
        with self.assertRaisesRegex(SystemExit, "different CLI wrapper"):
            pilot.bind()
        self.assertEqual(self.bots_path.read_bytes(), before)

    def test_existing_server_is_preserved_when_explicitly_reused(self):
        pilot.OV_ROOT.mkdir()
        server = {"server": {"host": "127.0.0.1", "port": 1933},
                  "embedding": {"dense": {"provider": "local", "dimension": 512}},
                  "vlm": {"model": "existing-model"}}
        path = pilot.OV_ROOT / "ov.conf"
        path.write_text(json.dumps(server))
        before = path.read_bytes()
        with self.assertRaisesRegex(SystemExit, "existing OpenViking server config"):
            self.configure()
        self.assertEqual(path.read_bytes(), before)
        self.configure(use_existing_server=True)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(pilot.load_runtime()["vlm_model"], "existing-model")


if __name__ == "__main__":
    unittest.main()
