#!/usr/bin/env python3
"""Read-only structural validation of a local GALE01 revision 2 disc."""

import argparse
import hashlib
import json
import os
import stat
import struct
import subprocess
import sys
from pathlib import Path

EXPECTED_DOL_SHA1 = "08e0bf20134dfcb260699671004527b2d6bb1a45"
CHUNK_SIZE = 1024 * 1024
MAX_FST_SIZE = 16 * 1024 * 1024
MAX_NAME_SIZE = 4096
SYSTEM_END = 0x2440


class DiscError(ValueError):
    """The disc or extraction destination failed validation."""


def _require(condition, message):
    if not condition:
        raise DiscError(message)


def _bounds(offset, size, limit, label):
    _require(
        0 <= offset <= limit and 0 <= size <= limit - offset,
        f"{label} is outside its containing region",
    )


def _read(stream, offset, size, limit, label):
    _bounds(offset, size, limit, label)
    _require(size <= CHUNK_SIZE, f"{label} exceeds the bounded read size")
    stream.seek(offset)
    result = stream.read(size)
    _require(len(result) == size, f"{label} is truncated")
    return result


def _u32(data, offset=0):
    return struct.unpack_from(">I", data, offset)[0]


def _nonoverlap(ranges, label):
    ordered = sorted((start, start + size) for start, size in ranges if size)
    for previous, current in zip(ordered, ordered[1:]):
        _require(previous[1] <= current[0], f"{label} overlap")


def _hash_region(stream, offset, size, algorithm):
    digest = hashlib.new(algorithm)
    stream.seek(offset)
    remaining = size
    while remaining:
        chunk = stream.read(min(CHUNK_SIZE, remaining))
        _require(bool(chunk), "Input was truncated while hashing")
        digest.update(chunk)
        remaining -= len(chunk)
    return digest.hexdigest()


def _dol(stream, offset, disc_size):
    _require(offset >= SYSTEM_END, "DOL overlaps the disc system header")
    header = _read(stream, offset, 0x100, disc_size, "DOL header")
    sections = []
    for index in range(18):
        file_offset = _u32(header, index * 4)
        address = _u32(header, 0x48 + index * 4)
        size = _u32(header, 0x90 + index * 4)
        if not size:
            continue
        _require(file_offset >= 0x100, "DOL section overlaps its header")
        _bounds(offset + file_offset, size, disc_size, "DOL section")
        _bounds(address, size, 1 << 32, "DOL load address")
        sections.append(
            {
                "kind": "text" if index < 7 else "data",
                "offset": file_offset,
                "address": address,
                "size": size,
            }
        )
    _require(bool(sections), "DOL contains no sections")
    _nonoverlap([(s["offset"], s["size"]) for s in sections], "DOL file sections")
    _nonoverlap([(s["address"], s["size"]) for s in sections], "DOL memory sections")
    entry = _u32(header, 0xE0)
    _require(
        any(
            s["kind"] == "text" and s["address"] <= entry < s["address"] + s["size"]
            for s in sections
        ),
        "DOL entry point is outside text sections",
    )
    # BSS can include loaded data in real DOLs; validate overflow, not overlap.
    _bounds(_u32(header, 0xD8), _u32(header, 0xDC), 1 << 32, "DOL BSS")
    span = max(s["offset"] + s["size"] for s in sections)
    sha1 = _hash_region(stream, offset, span, "sha1")
    return {
        "offset": offset,
        "size": span,
        "sections": len(sections),
        "entry_point": entry,
        "sha1": sha1,
        "expected_sha1": EXPECTED_DOL_SHA1,
        "matches_expected": sha1 == EXPECTED_DOL_SHA1,
    }


def _fst(stream, offset, size, disc_size, dol):
    _require(offset >= SYSTEM_END, "FST overlaps the disc system header")
    _require(12 <= size <= MAX_FST_SIZE, "FST size is outside the supported bounds")
    _bounds(offset, size, disc_size, "FST")
    root = _read(stream, offset, 12, disc_size, "FST root")
    _require(
        _u32(root) == 0x01000000 and _u32(root, 4) == 0,
        "FST root must be an unnamed directory with parent zero",
    )
    count = _u32(root, 8)
    _require(1 <= count <= size // 12, "FST entry count exceeds its table")
    strings = offset + count * 12
    strings_size = size - count * 12
    _require(strings_size > 0, "FST has no string table")
    stack = [(0, count)]
    extents = [(0, SYSTEM_END), (dol["offset"], dol["size"]), (offset, size)]
    _nonoverlap(extents, "Disc system regions")
    files, directories = 0, 1
    for index in range(1, count):
        while stack and index == stack[-1][1]:
            stack.pop()
        _require(bool(stack) and index < stack[-1][1], "FST directory tree is invalid")
        entry = _read(stream, offset + index * 12, 12, disc_size, "FST entry")
        kind = entry[0]
        _require(kind in (0, 1), "FST entry has an unknown type")
        name_offset = _u32(entry) & 0xFFFFFF
        _require(0 <= name_offset < strings_size, "FST name offset is invalid")
        _require(
            name_offset == 0
            or _read(stream, strings + name_offset - 1, 1, disc_size, "FST name boundary") == b"\0",
            "FST name offset points inside another name",
        )
        name = _read(
            stream,
            strings + name_offset,
            min(MAX_NAME_SIZE, strings_size - name_offset),
            disc_size,
            "FST name",
        )
        end = name.find(b"\0")
        _require(end > 0, "FST name is empty, unterminated or too long")
        value, length = _u32(entry, 4), _u32(entry, 8)
        if kind == 1:
            _require(value == stack[-1][0], "FST directory has the wrong parent")
            _require(index < length <= stack[-1][1], "FST directory end is invalid")
            stack.append((index, length))
            directories += 1
        else:
            _bounds(value, length, disc_size, "FST file")
            if length:
                extents.append((value, length))
            files += 1
    _nonoverlap(extents, "Disc file and system extents")
    return {
        "offset": offset,
        "size": size,
        "entries": count,
        "files": files,
        "directories": directories,
    }


def validate_disc(path, full_sha256=False):
    """Return structural metadata and hashes without writing disc content."""
    with Path(path).open("rb") as stream:
        disc_size = os.fstat(stream.fileno()).st_size
        header = _read(stream, 0, 0x440, disc_size, "Disc header")
        _require(_u32(header, 0x1C) == 0xC2339F3D, "GameCube header magic does not match")
        _require(header[:6] == b"GALE01", "Expected game ID GALE01")
        _require(header[6] == 0, "Expected disc number 0")
        _require(header[7] == 2, "Expected revision 2 (NTSC 1.02)")
        dol = _dol(stream, _u32(header, 0x420), disc_size)
        fst_size = _u32(header, 0x428)
        _require(fst_size <= _u32(header, 0x42C), "FST size exceeds its maximum size")
        fst = _fst(stream, _u32(header, 0x424), fst_size, disc_size, dol)
        report = {
            "game_id": "GALE01",
            "disc_number": 0,
            "revision": 2,
            "disc_size": disc_size,
            "structure_valid": True,
            "dol": dol,
            "fst": fst,
            "hash_scope": "DOL header through the greatest section end; not full-disc authenticity",
        }
        if full_sha256:
            report["iso_sha256"] = _hash_region(stream, 0, disc_size, "sha256")
        return report


def _plain_path(path):
    """Reject traversal spelling and filesystem aliases before resolving."""
    path = Path(path)
    _require(".." not in path.parts, "Parent traversal is not allowed for extraction")
    for part in path.parts[1:] if path.is_absolute() else path.parts:
        _require(
            part == part.rstrip(" .") and ":" not in part,
            "Ambiguous path components and alternate data streams are not allowed",
        )
    absolute = path.absolute()
    for component in [*reversed(absolute.parents), absolute]:
        try:
            info = component.lstat()
        except FileNotFoundError:
            continue
        _require(
            not stat.S_ISLNK(info.st_mode) and not (getattr(info, "st_file_attributes", 0) & 0x400),
            "Symlink, junction or reparse-point paths are not allowed for extraction",
        )
    return absolute.resolve()


def _ignored(path, repository):
    # These read-only local Git queries make no network calls.
    environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    try:
        result = subprocess.run(
            ["git", "-C", str(repository), "check-ignore", "-q", "--", str(path)],
            env=environment,
            capture_output=True,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise DiscError("Git is required to verify private extraction storage") from error
    _require(result.returncode == 0, "Extraction root and output must be ignored by Git")


def extract_dol(path, output, private_root):
    """Validate then exclusively create a matching DOL in ignored private storage."""
    _require(Path(private_root).is_absolute(), "--private-root must be an absolute path")
    root = _plain_path(private_root)
    _require(
        root.name == ".private" and root.is_dir(),
        "Private root must be an existing directory named .private",
    )
    destination = _plain_path(output)
    _require(
        destination != root and destination.is_relative_to(root),
        "Extraction output must be below the private root",
    )
    _require(destination != Path(path).resolve(), "Extraction output collides with the input")
    _require(not destination.exists(), "Extraction output already exists")
    _ignored(root, root.parent)
    _ignored(destination, root.parent)
    report = validate_disc(path)
    _require(
        report["dol"]["matches_expected"],
        "Refusing extraction because the DOL SHA-1 does not match",
    )
    # Make one directory at a time and recheck each component before using it.
    parent = root
    for part in destination.relative_to(root).parts[:-1]:
        parent = parent / part
        parent.mkdir(exist_ok=True)
        _plain_path(parent)
    _plain_path(destination)
    _ignored(destination, root.parent)
    created = False
    try:
        with Path(path).open("rb") as source:
            with destination.open("xb") as target:
                created = True
                source.seek(report["dol"]["offset"])
                remaining = report["dol"]["size"]
                digest = hashlib.sha1()
                while remaining:
                    chunk = source.read(min(CHUNK_SIZE, remaining))
                    _require(bool(chunk), "Input was truncated during extraction")
                    digest.update(chunk)
                    target.write(chunk)
                    remaining -= len(chunk)
                _require(
                    digest.hexdigest() == EXPECTED_DOL_SHA1,
                    "Input changed between validation and extraction",
                )
    except (OSError, DiscError, KeyboardInterrupt):
        if created:
            destination.unlink(missing_ok=True)
        raise
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path, help="Local uncompressed ISO or GCM image")
    parser.add_argument(
        "--sha256", action="store_true", help="Also stream the entire image through SHA-256"
    )
    parser.add_argument("--json", action="store_true", help="Print a metadata-only JSON report")
    parser.add_argument(
        "--extract-dol",
        type=Path,
        metavar="OUTPUT",
        help="Create a new main.dol below ignored .private storage",
    )
    parser.add_argument(
        "--private-root",
        type=Path,
        help="Absolute existing ignored .private directory; required for extraction",
    )
    args = parser.parse_args(argv)
    if bool(args.extract_dol) != bool(args.private_root):
        parser.error("--extract-dol and --private-root must be used together")
    try:
        report = validate_disc(args.image, full_sha256=args.sha256)
        if args.extract_dol:
            extract_dol(args.image, args.extract_dol, args.private_root)
            report["extracted_dol"] = str(args.extract_dol.resolve())
        if args.json:
            print(json.dumps(report, indent=2))
        else:
            print(
                f"{report['game_id']} revision {report['revision']}, disc {report['disc_number']}: structure valid"
            )
            print(f"DOL SHA-1: {report['dol']['sha1']}")
            print(f"Expected DOL match: {report['dol']['matches_expected']}")
            print(
                f"FST: {report['fst']['files']} files, {report['fst']['directories']} directories"
            )
            print(report["hash_scope"])
            if "iso_sha256" in report:
                print(f"ISO SHA-256: {report['iso_sha256']}")
            if "extracted_dol" in report:
                print(f"Extracted DOL: {report['extracted_dol']}")
        return 0 if report["dol"]["matches_expected"] else 1
    except (OSError, DiscError) as error:
        if args.json:
            print(json.dumps({"error": str(error), "structure_valid": False}))
        else:
            print(f"Validation failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
