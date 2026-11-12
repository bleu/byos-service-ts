#!/usr/bin/env bash
# Streamed over SSH; no remote helper needs to exist before checkout preparation.
set -euo pipefail
exec python3 - "$@" <<'PY'
import fcntl
import os
from pathlib import Path
import re
import subprocess
import sys


def git(*args, capture=False, check=True):
    result = subprocess.run(['git', *args], check=check, text=True,
                            stdout=subprocess.PIPE if capture else None)
    return result.stdout.strip() if capture else result.returncode


try:
    repo_arg, mode, *args = sys.argv[1:]
    repo = Path(repo_arg)
    if not repo.is_absolute() or repo == Path('/'):
        raise ValueError('Invalid deployment path')
    if mode not in ('release', 'build', 'deploy', 'logs', 'check-ports', 'delete-remote-env'):
        raise ValueError('Unknown deployment command')
    if mode == 'release' and (len(args) != 2 or args[1] != '--all'):
        raise ValueError('Usage: release-remote <full-sha> --all')
    if mode == 'build' and len(args) > 1:
        raise ValueError('Usage: build-remote [full-sha]')
    if mode in ('release', 'build') and args and not re.fullmatch(r'[0-9a-f]{40}', args[0]):
        raise ValueError('Expected a full 40-character commit SHA')
    os.umask(0o077)
    state = repo.parent / '.byos-deployment-state'
    state.mkdir(mode=0o700, exist_ok=True)
    state.chmod(0o700)
    lock = (state / 'release.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX)
    # FD 9 survives exec into the requested revision's server implementation.
    os.dup2(lock.fileno(), 9, inheritable=True)
    os.chdir(repo)
    if mode in ('release', 'build'):
        if git('diff', '--quiet', 'HEAD', '--', check=False):
            raise ValueError('Tracked checkout modifications block release')
        git('fetch', 'origin', 'main')
        sha = args[0] if args else git('rev-parse', 'refs/remotes/origin/main', capture=True)
        if not args:
            print(f'Building remote origin/main revision {sha} (manual build; no CI claim)', flush=True)
        if git('cat-file', '-e', sha + '^{commit}', check=False):
            git('fetch', 'origin', sha)
        git('checkout', '--detach', sha)
        if git('rev-parse', 'HEAD', capture=True) != sha:
            raise ValueError('Prepared checkout revision mismatch')
        args = [sha, *args[1:]]
    os.execv(sys.executable, [sys.executable, 'scripts/deployment/server.py', str(state), mode, *args])
except (ValueError, OSError, subprocess.CalledProcessError) as error:
    print(f'Remote bootstrap failed: {error}', file=sys.stderr)
    sys.exit(1)
PY
