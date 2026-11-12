"""Local SSH/rsync adapters. No deployment decisions belong here."""

import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def connection():
    values = {}
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            match = re.fullmatch(
                r"(DEPLOY_HOST|DEPLOY_USER|DEPLOY_PATH)=(.*)", line.strip()
            )
            if match:
                value = match[2].strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                    value = value[1:-1]
                values[match[1]] = value
    values.update(
        {
            key: os.environ[key]
            for key in ("DEPLOY_HOST", "DEPLOY_USER", "DEPLOY_PATH")
            if key in os.environ
        }
    )
    host = values.get("DEPLOY_HOST", "")
    user = values.get("DEPLOY_USER", "")
    path = values.get("DEPLOY_PATH", "/home/bleu/byos-service-ts")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]*", host) or not re.fullmatch(
        r"[a-z_][a-z0-9_-]*", user
    ):
        raise ValueError(
            "Set valid DEPLOY_HOST and DEPLOY_USER in the environment or local .env"
        )
    if (
        not re.fullmatch(r"/[A-Za-z0-9_./-]+", path)
        or ".." in Path(path).parts
        or path == "/"
    ):
        raise ValueError("Invalid DEPLOY_PATH")
    return f"{user}@{host}", path.rstrip("/")


def main():
    mode, *args = sys.argv[1:]
    target, path = connection()
    if mode in ("push-secrets", "pull-secrets"):
        if args:
            raise ValueError("Secret sync takes no arguments")
        local = ROOT / "env"
        if mode == "push-secrets" and (not local.is_dir() or local.is_symlink()):
            raise ValueError("Local env/ must be a real directory")
        # No --delete: destination-only files always survive either direction.
        remote = f"{target}:{path}/env/"
        ends = (
            [f"{local}/", remote] if mode == "push-secrets" else [remote, f"{local}/"]
        )
        subprocess.run(["rsync", "-az", "--safe-links", "--", *ends], check=True)
        return
    if mode not in (
        "release",
        "build",
        "deploy",
        "logs",
        "check-ports",
        "delete-remote-env",
    ):
        raise ValueError("Unknown remote command")
    command = shlex.join(["bash", "-s", "--", path, mode, *args])
    subprocess.run(
        ["ssh", "-o", "BatchMode=yes", target, command],
        input=(ROOT / "scripts/deployment/remote-bootstrap.sh").read_bytes(),
        check=True,
    )


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"Deployment command failed: {error}", file=sys.stderr)
        sys.exit(1)
