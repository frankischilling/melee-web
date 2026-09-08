"""Only synthetic bytes are used here; no retail data is a fixture."""

import hashlib
import importlib.util
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / "tools" / "disc.py"
spec = importlib.util.spec_from_file_location("disc", MODULE)
disc = importlib.util.module_from_spec(spec) if MODULE.exists() else None
if disc is not None:
    spec.loader.exec_module(disc)


def word(image, offset, value):
    struct.pack_into(">I", image, offset, value)


def synthetic_disc():
    image = bytearray(0x6000)
    image[:8] = b"GALE01\x00\x02"
    word(image, 0x1C, 0xC2339F3D)
    image[0x20:0x29] = b"Synthetic"
    word(image, 0x420, 0x3000)
    word(image, 0x424, 0x4000)
    word(image, 0x428, 48 + 11)
    word(image, 0x42C, 48 + 11)
    word(image, 0x3000, 0x100)
    word(image, 0x3048, 0x80003100)
    word(image, 0x3090, 16)
    word(image, 0x30E0, 0x80003100)
    image[0x3100:0x3110] = b"synthetic code!!"
    # Root, folder, file in folder, file in root.
    struct.pack_into(">III", image, 0x4000, 0x01000000, 0, 4)
    struct.pack_into(">III", image, 0x400C, 0x01000001, 0, 3)
    struct.pack_into(">III", image, 0x4018, 5, 0x5000, 4)
    struct.pack_into(">III", image, 0x4024, 7, 0x5010, 8)
    image[0x4030:0x403B] = b"\x00dir\x00a\x00bbb\x00"
    return image


class ValidationTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(disc, "tools/disc.py must implement the validator")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "synthetic.iso"

    def validate(self, image=None, **kwargs):
        self.path.write_bytes(synthetic_disc() if image is None else image)
        return disc.validate_disc(self.path, **kwargs)

    def test_valid_disc_metadata_and_exact_span_hash(self):
        data = synthetic_disc()
        report = self.validate(data, full_sha256=True)
        self.assertEqual(report["game_id"], "GALE01")
        self.assertEqual(report["revision"], 2)
        self.assertEqual(report["disc_number"], 0)
        self.assertEqual(report["dol"]["size"], 0x110)
        self.assertEqual(report["dol"]["sha1"], hashlib.sha1(data[0x3000:0x3110]).hexdigest())
        self.assertFalse(report["dol"]["matches_expected"])
        self.assertEqual(report["fst"]["files"], 2)
        self.assertEqual(report["fst"]["directories"], 2)
        self.assertEqual(report["iso_sha256"], hashlib.sha256(data).hexdigest())

    def test_default_does_not_hash_whole_disc(self):
        self.assertNotIn("iso_sha256", self.validate())

    def test_string_table_can_start_with_first_filename(self):
        data = synthetic_disc()
        data[0x4030:0x403B] = b"dir\x00a\x00bbb\x00\x00"
        word(data, 0x400C, 0x01000000)
        word(data, 0x4018, 4)
        word(data, 0x4024, 6)
        self.assertEqual(self.validate(data)["fst"]["entries"], 4)

    def test_identity_fields_and_header_magic_are_required(self):
        for offset, value in [(0, ord("X")), (6, 1), (7, 1), (0x1C, 0)]:
            with self.subTest(offset=offset):
                data = synthetic_disc()
                data[offset] = value
                with self.assertRaises(disc.DiscError):
                    self.validate(data)

    def test_truncated_image_is_rejected(self):
        for size in [0, 0x42F, 0x30FF, 0x310F, 0x403A, 0x5017]:
            with self.subTest(size=size), self.assertRaises(disc.DiscError):
                self.validate(synthetic_disc()[:size])

    def test_excessive_fst_size_is_rejected_before_allocation(self):
        data = synthetic_disc()
        word(data, 0x428, 0xFFFFFFFF)
        word(data, 0x42C, 0xFFFFFFFF)
        with self.assertRaises(disc.DiscError):
            self.validate(data)

    def test_empty_file_at_end_of_disc_is_valid(self):
        data = synthetic_disc()
        word(data, 0x4028, len(data))
        word(data, 0x402C, 0)
        self.assertEqual(self.validate(data)["fst"]["files"], 2)

    def test_dol_rejects_bad_file_and_memory_sections(self):
        changes = [
            [(0x3000, 0xFC)],
            [(0x3090, 0xFFFFFFFF)],
            [(0x3004, 0x108), (0x304C, 0x80004000), (0x3094, 8)],
            [(0x3004, 0x110), (0x304C, 0x80003108), (0x3094, 8)],
            [(0x3048, 0xFFFFFFFC)],
            [(0x30E0, 0x80006000)],
            [(0x3090, 0)],
            [(0x420, 0x4000)],
        ]
        for updates in changes:
            with self.subTest(updates=updates):
                data = synthetic_disc()
                for offset, value in updates:
                    word(data, offset, value)
                with self.assertRaises(disc.DiscError):
                    self.validate(data)

    def test_fst_rejects_invalid_roots_counts_types_and_trees(self):
        changes = [
            [(0x4000, 0)],
            [(0x4004, 1)],
            [(0x4008, 0)],
            [(0x4008, 0xFFFFFFFF)],
            [(0x400C, 0x02000001)],
            [(0x4010, 1)],
            [(0x4014, 1)],
            [(0x4014, 5)],
            [(0x4024, 0x01000007), (0x4028, 1), (0x402C, 4)],
            [(0x428, 11)],
            [(0x42C, 12)],
            [(0x424, 0x3100)],
        ]
        for updates in changes:
            with self.subTest(updates=updates):
                data = synthetic_disc()
                for offset, value in updates:
                    word(data, offset, value)
                with self.assertRaises(disc.DiscError):
                    self.validate(data)

    def test_fst_rejects_bad_name_offsets_and_unterminated_names(self):
        for value in [0, 2, 11, 0x00FFFFFF]:
            data = synthetic_disc()
            word(data, 0x4018, value)
            with self.subTest(value=value), self.assertRaises(disc.DiscError):
                self.validate(data)
        data = synthetic_disc()
        data[0x403A] = ord("x")
        with self.assertRaises(disc.DiscError):
            self.validate(data)

    def test_fst_rejects_out_of_bounds_and_overlapping_files(self):
        for offset, value in [
            (0x401C, 0xFFFF0000),
            (0x4020, 0xFFFFFFFF),
            (0x4028, 0x5002),
            (0x401C, 0x3000),
            (0x401C, 0x4000),
            (0x401C, 0x100),
        ]:
            data = synthetic_disc()
            word(data, offset, value)
            with self.subTest(offset=offset, value=value), self.assertRaises(disc.DiscError):
                self.validate(data)


class ExtractionTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(hasattr(disc, "extract_dol"), "Private extraction must be implemented")
        self.root = MODULE.parents[1] / ".private"
        self.root.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=self.root)
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.source = self.directory / "synthetic.iso"
        self.source.write_bytes(synthetic_disc())
        self.output = self.directory / "new" / "main.dol"
        expected = hashlib.sha1(synthetic_disc()[0x3000:0x3110]).hexdigest()
        self.hash_override = patch.object(disc, "EXPECTED_DOL_SHA1", expected)
        self.hash_override.start()
        self.addCleanup(self.hash_override.stop)

    def test_extracts_exact_dol_only_to_new_ignored_private_path(self):
        disc.extract_dol(self.source, self.output, self.root)
        self.assertEqual(self.output.read_bytes(), synthetic_disc()[0x3000:0x3110])
        self.assertEqual(self.source.read_bytes(), synthetic_disc())

    def test_rejects_public_output_and_unignored_private_root(self):
        with self.assertRaises(disc.DiscError):
            disc.extract_dol(self.source, MODULE.parents[1] / "public.dol", self.root)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / ".private"
            root.mkdir()
            with self.assertRaises(disc.DiscError):
                disc.extract_dol(self.source, root / "main.dol", root)
            self.assertFalse((root / "main.dol").exists())

    def test_rejects_wrong_root_name_and_path_traversal(self):
        for root, output in [
            (self.directory, self.output),
            (self.root, self.directory / ".." / "escape.dol"),
            (self.root, self.directory / "alias." / "main.dol"),
            (self.root, self.directory / "main.dol:stream"),
        ]:
            with self.subTest(output=output), self.assertRaises(disc.DiscError):
                disc.extract_dol(self.source, output, root)

    def test_rejects_overwrite_and_input_collision(self):
        self.output.parent.mkdir()
        self.output.write_bytes(b"keep")
        for output in [self.output, self.source]:
            with self.subTest(output=output), self.assertRaises(disc.DiscError):
                disc.extract_dol(self.source, output, self.root)
        self.assertEqual(self.output.read_bytes(), b"keep")

    def test_rejects_symlink_or_junction_ancestor(self):
        target = self.directory / "target"
        target.mkdir()
        link = self.directory / "alias"
        try:
            link.symlink_to(target, target_is_directory=True)
        except OSError:
            if sys.platform != "win32":
                self.skipTest("This environment does not allow directory symlinks")
            subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(link), str(target)],
                check=True,
                capture_output=True,
            )
        try:
            with self.assertRaises(disc.DiscError):
                disc.extract_dol(self.source, link / "main.dol", self.root)
            self.assertFalse((target / "main.dol").exists())
        finally:
            if link.is_symlink():
                link.unlink()
            else:
                link.rmdir()

    def test_rejects_hash_mismatch_without_creating_output(self):
        self.hash_override.stop()
        with self.assertRaises(disc.DiscError):
            disc.extract_dol(self.source, self.output, self.root)
        self.assertFalse(self.output.exists())

    def test_keyboard_interrupt_removes_created_output(self):
        with patch.object(disc.hashlib, "sha1", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                disc.extract_dol(self.source, self.output, self.root)
        self.assertFalse(self.output.exists())

    def test_rejects_symlink_private_root(self):
        container = self.directory / "container"
        container.mkdir()
        link = container / ".private"
        try:
            link.symlink_to(self.root, target_is_directory=True)
        except OSError:
            if sys.platform != "win32":
                self.skipTest("This environment does not allow directory symlinks")
            subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(link), str(self.root)],
                check=True,
                capture_output=True,
            )
        try:
            with self.assertRaises(disc.DiscError):
                disc.extract_dol(self.source, link / "main.dol", link)
        finally:
            if link.is_symlink():
                link.unlink()
            else:
                link.rmdir()


class CliTests(unittest.TestCase):
    def test_missing_image_produces_error_without_traceback(self):
        with tempfile.TemporaryDirectory() as temp:
            result = subprocess.run(
                [sys.executable, str(MODULE), str(Path(temp) / "missing.iso"), "--json"],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn('"error"', result.stdout)
            self.assertNotIn("Traceback", result.stderr)

    def test_extraction_requires_private_root_argument(self):
        result = subprocess.run(
            [sys.executable, str(MODULE), "missing.iso", "--extract-dol", "main.dol"],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("must be used together", result.stderr)

    def test_json_hash_mismatch_has_nonzero_exit_and_no_extraction(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "synthetic.iso"
            path.write_bytes(synthetic_disc())
            result = subprocess.run(
                [sys.executable, str(MODULE), str(path), "--json"], capture_output=True, text=True
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn('"matches_expected": false', result.stdout)
            self.assertEqual(list(Path(temp).iterdir()), [path])


if __name__ == "__main__":
    unittest.main()
