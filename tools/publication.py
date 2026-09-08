"""Reject private material and unreviewed binary assets from Git snapshots."""

import argparse
import subprocess
from pathlib import PurePosixPath

MAX_SOURCE_BYTES = 2 * 1024 * 1024
PRIVATE_PARTS = {
    ".private",
    "private",
    "local",
    "vendor",
    ".worktrees",
    "extracted",
    "screenshots",
    "captures",
    "memory-cards",
    "saves",
    "node_modules",
    "target",
    "dist",
    "pkg",
}
SOURCE_SUFFIXES = {
    ".rs",
    ".py",
    ".ts",
    ".tsx",
    ".js",
    ".mjs",
    ".cjs",
    ".html",
    ".css",
    ".md",
    ".toml",
    ".json",
    ".lock",
    ".yml",
    ".yaml",
    ".txt",
    ".sh",
    ".ps1",
    ".wgsl",
    ".wesl",
    ".c",
    ".h",
    ".cpp",
    ".hpp",
}
SOURCE_NAMES = {"license", "copying", "codeowners", ".gitignore", ".gitattributes", ".editorconfig"}


def check_entry(path: str, mode: str, data: bytes) -> list[str]:
    """Check the exact bytes stored in Git, never a working-tree substitute."""
    name = PurePosixPath(path.lower())
    errors = []
    if mode not in {"100644", "100755"}:
        errors.append("only regular source files may be published")
    if any(part in PRIVATE_PARTS for part in name.parts):
        errors.append("private or generated directory")
    if name.suffix not in SOURCE_SUFFIXES and name.name not in SOURCE_NAMES:
        errors.append("file format has not been approved for publication")
    if len(data) > MAX_SOURCE_BYTES:
        errors.append("source file exceeds the 2 MiB review limit")
    try:
        decoded = data.decode("utf-8")
    except UnicodeDecodeError:
        errors.append("binary content is forbidden in source snapshots")
    else:
        if any(ord(char) < 32 and char not in "\t\n\r" for char in decoded):
            errors.append("binary control bytes are forbidden in source snapshots")
    return errors


def git(*args: str) -> bytes:
    return subprocess.check_output(["git", *args])


def snapshot_entries(staged: bool, revision: str):
    """Yield path/mode/object IDs without opening files or following links."""
    if staged:
        listing = git("ls-files", "--stage", "-z")
    else:
        # Resolve a commit first so a supplied revision cannot become an option.
        commit = git("rev-parse", "--verify", f"{revision}^{{commit}}").decode().strip()
        listing = git("ls-tree", "-r", "-z", "--full-tree", commit)
    for entry in listing.split(b"\0"):
        if not entry:
            continue
        metadata, raw_path = entry.split(b"\t", 1)
        fields = metadata.decode("ascii").split()
        mode, object_id = (fields[0], fields[1]) if staged else (fields[0], fields[2])
        if staged and fields[2] != "0":
            raise ValueError("resolve all merge conflicts before checking publication")
        yield raw_path.decode("utf-8"), mode, object_id


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staged", action="store_true", help="check the Git index")
    parser.add_argument("--revision", default="HEAD", help="commit to check (default HEAD)")
    args = parser.parse_args()
    failures = 0
    count = 0
    try:
        for path, mode, object_id in snapshot_entries(args.staged, args.revision):
            count += 1
            size = int(git("cat-file", "-s", object_id))
            if size > MAX_SOURCE_BYTES:
                problems = ["object exceeds the 2 MiB review limit; content was not read"]
            else:
                data = git("cat-file", "-p", object_id)
                problems = check_entry(path, mode, data)
            for problem in problems:
                failures += 1
                print(f"REJECT {path}: {problem}")
    except (subprocess.CalledProcessError, UnicodeError, ValueError) as error:
        print(f"Publication check failed: {error}")
        return 1
    if failures:
        print(f"Rejected snapshot: {failures} problem(s) in {count} entries.")
        return 1
    print(f"Source-only publication check passed for {count} entries.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
