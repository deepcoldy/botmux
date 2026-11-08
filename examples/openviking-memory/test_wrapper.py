"""Launch boundaries: project selection, opt-in identity, and disabled auto reads."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import tomllib
import unittest


class MemoryLaunchTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "bin").mkdir()
        self.wrapper = self.root / "bin/codex-openviking"
        shutil.copy2(Path(__file__).parent / "bin/codex-openviking", self.wrapper)
        shutil.copy2(Path(__file__).parent / "memory-usage.md", self.root / "memory-usage.md")
        self.codex = self.root / "codex"
        self.codex.write_text(
            "#!/usr/bin/env python3\nimport json,os,sys\n"
            "print(json.dumps({'args':sys.argv[1:],'env':dict(os.environ)}))\n"
        )
        self.codex.chmod(0o755)
        node = self.root / "bin/node"
        node.write_text(
            "#!/usr/bin/env python3\nimport json,sys\n"
            "print(json.dumps({'OPENVIKING_PEER_ID':sys.argv[2],"
            "'OPENVIKING_CREDENTIAL_SOURCE':'env','OPENVIKING_USER':'selected-user',"
            "'OPENVIKING_ACCOUNT':'default','OPENVIKING_URL':'http://127.0.0.1:1933'}))\n"
        )
        node.chmod(0o755)
        (self.root / "runtime.json").write_text(json.dumps({
            "bot_app_id": "selected-bot", "client_config": str(self.root / "ovcli.conf"),
            "codex": str(self.codex), "plugin": "openviking-memory@openviking",
        }))
        self.environment = dict(os.environ, PATH=str(self.root / "bin") + os.pathsep + os.environ.get("PATH", ""),
                                BOTMUX_LARK_APP_ID="selected-bot", CODEX_HOME=str(self.root / "codex-home"))

    def launch(self, arguments=(), **environment):
        return subprocess.run([str(self.wrapper), *arguments], cwd=self.root,
                              env=dict(self.environment, **environment), text=True, capture_output=True)

    def test_project_selection_matches_codex_working_directory(self):
        project = self.root / "project with spaces"
        for arguments in (["-C", str(project)], ["--cd", str(project)],
                          ["--cd=" + str(project)], ["-C" + str(project)]):
            with self.subTest(arguments=arguments):
                result = self.launch(arguments)
                self.assertEqual(result.returncode, 0, result.stderr)
                launched = json.loads(result.stdout)
                self.assertEqual(launched["env"]["OPENVIKING_PEER_ID"], str(project))
                self.assertEqual(launched["env"]["CODEX_HOME"], self.environment["CODEX_HOME"])
                self.assertEqual(launched["args"][-len(arguments):], arguments)
                encoded = next(arg.split("=", 1)[1] for arg in launched["args"] if arg.startswith("mcp_servers.openviking="))
                server = tomllib.loads("server=" + encoded)["server"]
                self.assertFalse(server["enabled"])

    def test_automatic_reads_cannot_be_reenabled_by_inherited_environment(self):
        result = self.launch(OPENVIKING_AUTO_RECALL="1", OPENVIKING_NO_AUTO_INJECT="0",
                             OPENVIKING_RESUME_ARCHIVE_INJECT="1", OPENVIKING_RECALL_PEER_SCOPE="all")
        self.assertEqual(result.returncode, 0, result.stderr)
        environment = json.loads(result.stdout)["env"]
        self.assertEqual(environment["OPENVIKING_AUTO_RECALL"], "0")
        self.assertEqual(environment["OPENVIKING_NO_AUTO_INJECT"], "1")
        self.assertEqual(environment["OPENVIKING_RESUME_ARCHIVE_INJECT"], "0")
        self.assertEqual(environment["OPENVIKING_RECALL_PEER_SCOPE"], "actor")

    def test_other_bot_is_rejected_before_launch(self):
        result = self.launch(BOTMUX_LARK_APP_ID="other-bot")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("different Botmux Bot", result.stderr)

    def test_memory_guidance_preserves_existing_profile_instructions(self):
        codex_home = Path(self.environment["CODEX_HOME"])
        codex_home.mkdir()
        (codex_home / "config.toml").write_text(
            'developer_instructions="global instruction"\n'
            '[profiles.selected]\ndeveloper_instructions="profile instruction"\n'
        )
        result = self.launch(["--profile", "selected"])
        self.assertEqual(result.returncode, 0, result.stderr)
        arguments = json.loads(result.stdout)["args"]
        encoded = next(arg.split("=", 1)[1] for arg in arguments if arg.startswith("developer_instructions="))
        instructions = json.loads(encoded)
        self.assertTrue(instructions.startswith("profile instruction\n\n"))
        self.assertIn("For self-contained tasks, answer directly", instructions)
        self.assertIn(str(self.root / "memory.mjs"), instructions)
        self.assertNotIn("{{MEMORY_COMMAND}}", instructions)
        self.assertEqual(arguments[-2:], ["--profile", "selected"])


if __name__ == "__main__":
    unittest.main()
