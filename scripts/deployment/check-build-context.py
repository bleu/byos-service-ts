"""Verify each production Dockerfile's ignore rules using only dummy secrets.

Requires Docker Engine + BuildKit. Never submits the real checkout as context.
"""

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main():
    for dockerfile in ("Dockerfile", "apps/admin/Dockerfile"):
        with tempfile.TemporaryDirectory() as temporary:
            context = Path(temporary) / "context"
            context.mkdir()
            shutil.copy(ROOT / ".dockerignore", context / ".dockerignore")
            destination = context / dockerfile
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text("FROM scratch\nCOPY . /\n")
            specific_ignore = ROOT / (dockerfile + ".dockerignore")
            if specific_ignore.exists():
                shutil.copy(specific_ignore, context / (dockerfile + ".dockerignore"))
            secrets = context / "env" / "dummy-project"
            secrets.mkdir(parents=True)
            for filename in (".env", ".env.byos", ".env.admin"):
                (secrets / filename).write_text("DUMMY_MARKER=must-not-enter-context\n")
            (context / "included-marker").write_text("must-enter-context\n")
            output = Path(temporary) / "output"
            subprocess.run(
                [
                    "docker",
                    "build",
                    "--file",
                    str(destination),
                    "--output",
                    f"type=local,dest={output}",
                    str(context),
                ],
                env={**os.environ, "DOCKER_BUILDKIT": "1"},
                check=True,
            )
            if not (output / "included-marker").is_file() or (output / "env").exists():
                raise RuntimeError(f"{dockerfile}: env/ build-context exclusion failed")
            print(f"{dockerfile}: dummy shared and service secrets excluded")


if __name__ == "__main__":
    main()
