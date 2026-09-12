#!/usr/bin/env python3
"""Portable ZIP-only build using the canonical PowerShell file allowlist."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import zipfile

ROOT = Path(__file__).resolve().parent.parent


def build(tag=None):
    manifest = json.loads((ROOT / "manifest.json").read_text())
    version = manifest["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:\.\d+)?", version):
        raise ValueError("Invalid manifest version")
    if tag is not None and tag != f"v{version}":
        raise ValueError("Tag and manifest version differ")
    note = ROOT / "release-notes" / f"v{version}.md"
    note_content = note.read_text()
    if not note_content.startswith(f"# better gmgn v{version}\n"):
        raise ValueError("Missing or mismatched release notes")
    required_sections = (
        "# better gmgn",
        "## Highlights",
        "## Installation",
        "## Usage",
        "## Updating",
        "## Security and privacy",
    )
    missing_sections = [section for section in required_sections if section not in note_content]
    if missing_sections:
        raise ValueError(f"Release notes are missing section: {missing_sections[0]}")
    source = (ROOT / "scripts" / "build-release.ps1").read_text()
    block = re.search(r"\$files = @\((.*?)\n\)", source, re.S)
    if block is None:
        raise ValueError("Canonical release file allowlist not found")
    names = re.findall(r"'([^']+)'", block[1])
    if not names or len(names) != len(set(names)):
        raise ValueError("Empty or duplicate release allowlist")
    payload = {}
    for name in names:
        file = (ROOT / name).resolve()
        if not file.is_relative_to(ROOT) or not file.is_file():
            raise ValueError(f"Invalid release file: {name}")
        payload[name] = file.read_bytes()
        if not payload[name]:
            raise ValueError(f"Empty release file: {name}")
    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    target = dist / f"gmgn-fomo-helper-v{version}.zip"
    temp = target.with_suffix(".zip.tmp")
    try:
        with zipfile.ZipFile(temp, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, data in payload.items():
                info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, data)
        with zipfile.ZipFile(temp) as archive:
            assert archive.testzip() is None
            assert archive.namelist() == names
            for name, data in payload.items():
                assert archive.read(name) == data, name
            assert json.loads(archive.read("manifest.json"))["version"] == version
        digest = hashlib.sha256(temp.read_bytes()).hexdigest()
        temp.replace(target)
        checksum = target.with_suffix(".zip.sha256")
        checksum.write_text(f"{digest}  {target.name}\n")
        assert hashlib.sha256(target.read_bytes()).hexdigest() == checksum.read_text().split()[0]
    finally:
        temp.unlink(missing_ok=True)
    print(json.dumps({"package": str(target), "version": version, "files": len(names), "sha256": digest, "verified": True}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag")
    build(parser.parse_args().tag)
