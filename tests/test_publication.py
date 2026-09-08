"""Synthetic checks for files that may enter Git or release sources."""

import contextlib
import io
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.publication import check_entry, main, snapshot_entries


class PublicationTests(unittest.TestCase):
    def test_source_text_is_allowed(self):
        self.assertEqual(check_entry("src/runtime.rs", "100644", b"fn main() {}\n"), [])

    def test_disc_extensions_are_case_insensitive(self):
        for name in ("game.ISO", "disc.GcM", "main.dol", "music.hps", "save.gci"):
            with self.subTest(name=name):
                self.assertTrue(check_entry(name, "100644", b"synthetic"))

    def test_private_directories_are_rejected_at_any_depth(self):
        for name in (".private/report.json", "test/PRIVATE/a.py", "captures/frame.txt"):
            with self.subTest(name=name):
                self.assertTrue(check_entry(name, "100644", b"synthetic"))

    def test_binary_renamed_as_source_is_rejected(self):
        self.assertTrue(check_entry("disc.txt", "100644", b"GALE01\0\x02"))
        self.assertTrue(check_entry("firmware.rs", "100644", b"\xff\xfe\x90"))

    def test_unreviewed_asset_formats_are_rejected(self):
        for name in ("image.png", "sound.wav", "game.zip", "blob.unknown"):
            with self.subTest(name=name):
                self.assertTrue(check_entry(name, "100644", b"synthetic"))

    def test_symlinks_and_submodules_are_rejected(self):
        self.assertTrue(check_entry("src/link.py", "120000", b"../.private/file"))
        self.assertTrue(check_entry("vendor", "160000", b""))

    def test_large_text_requires_review(self):
        self.assertTrue(check_entry("dump.txt", "100644", b"A" * (2 * 1024 * 1024 + 1)))

    def test_repository_metadata_is_allowed(self):
        for name in ("LICENSE", ".gitignore", ".github/workflows/check.yml"):
            with self.subTest(name=name):
                self.assertEqual(check_entry(name, "100644", b"source text\n"), [])

    def test_index_check_uses_staged_bytes_after_working_file_is_replaced(self):
        with tempfile.TemporaryDirectory() as temporary:
            subprocess.run(["git", "init", "-q", temporary], check=True)
            staged = Path(temporary) / "example.py"
            staged.write_bytes(b"binary\x00payload")
            subprocess.run(["git", "-C", temporary, "add", "example.py"], check=True)
            staged.write_text("print('clean working file')\n", encoding="utf-8")
            previous = Path.cwd()
            try:
                os.chdir(temporary)
                with patch("sys.argv", ["publication.py", "--staged"]):
                    with contextlib.redirect_stdout(io.StringIO()) as output:
                        self.assertEqual(main(), 1)
                self.assertIn("binary control bytes", output.getvalue())
            finally:
                os.chdir(previous)

    def test_merge_conflicts_are_rejected(self):
        with patch("tools.publication.git", return_value=b"100644 abc123 2\tfile.py\0"):
            with self.assertRaisesRegex(ValueError, "merge conflicts"):
                list(snapshot_entries(True, "HEAD"))

    def test_oversized_blob_is_rejected_without_reading_its_contents(self):
        calls = []

        def metadata_only(*args):
            calls.append(args)
            if args == ("ls-files", "--stage", "-z"):
                return b"100644 abc123 0\tfile.py\0"
            if args == ("cat-file", "-s", "abc123"):
                return b"2097153"
            self.fail(f"Unexpected content read: {args}")

        with patch("tools.publication.git", side_effect=metadata_only):
            with patch("sys.argv", ["publication.py", "--staged"]):
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(main(), 1)
        self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
