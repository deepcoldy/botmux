#!/usr/bin/env python3
"""Version-bound installer. Default is verification only; use --apply explicitly."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("skill", choices=["mindai", "picko"])
parser.add_argument("--root", required=True, type=Path)
parser.add_argument("--apply", action="store_true")
args = parser.parse_args()
artifact = Path(__file__).resolve().parent
root = args.root.resolve(strict=True)
manifest = json.loads((artifact / (args.skill + "-manifest.json")).read_text())
pending = []
for row in manifest["files"]:
    relative = Path(row["path"])
    if relative.is_absolute() or ".." in relative.parts:
        raise SystemExit("Unsafe manifest path")
    target = root / relative
    if target.is_symlink() or any(parent.is_symlink() for parent in target.parents if parent != root and root in parent.parents):
        raise SystemExit("Refusing symlink destination")
    existing = hashlib.sha256(target.read_bytes()).hexdigest() if target.exists() else None
    if existing == row["outputSha256"]:
        continue
    if existing != row["inputSha256"]:
        raise SystemExit("Version mismatch: " + row["path"])
    content = (artifact / args.skill / relative).read_bytes()
    if hashlib.sha256(content).hexdigest() != row["outputSha256"]:
        raise SystemExit("Artifact integrity failure")
    pending.append((target, content))
if args.apply:
    for target, content in pending:
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".managed-skill-", dir=target.parent)
        try:
            with os.fdopen(fd, "wb") as output:
                output.write(content)
                output.flush()
                os.fsync(output.fileno())
            os.chmod(temporary, target.stat().st_mode & 0o777 if target.exists() else 0o644)
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
print(json.dumps({"skill": args.skill, "verified": True, "changedFiles": len(pending), "applied": args.apply}))
