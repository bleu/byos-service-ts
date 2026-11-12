"""Shared server implementation. Invoked only by the locked remote bootstrap.

Compose resolves dotenv syntax; Python never sources secrets as shell code.
All persisted resolved configurations contain secrets and stay mode 0600.
"""

import copy
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

REVISION = "org.opencontainers.image.revision"
IMAGES = {
    "byos-service:local": "Dockerfile",
    "byos-admin:local": "apps/admin/Dockerfile",
}
SERVICES = {
    "postgres",
    "redis",
    "byos",
    "admin",
    "fynd",
    "fynd-subsolver",
    "binance-subsolver",
}
PORTS = {
    "postgres": "POSTGRES_HOST_PORT",
    "redis": "REDIS_HOST_PORT",
    "byos": "BYOS_PUBLIC_HOST_PORT",
    "admin": "ADMIN_HOST_PORT",
    "fynd": "FYND_HOST_PORT",
    "fynd-subsolver": "FYND_SUBSOLVER_HOST_PORT",
    "binance-subsolver": "BINANCE_SUBSOLVER_HOST_PORT",
}
# Infrastructure checks only; each application still validates its full Zod config at startup.
REQUIRED = {
    "byos": (
        "CHAIN_ID",
        "RPC_URL",
        "ESCROW_ADDRESS",
        "TRAMPOLINE_FACTORY",
        "OPERATOR_PRIVATE_KEY",
        "DEFAULT_GAS_PRICE",
    ),
    "admin": ("CHAIN_ID", "RPC_URL", "ESCROW_ADDRESS"),
    "fynd-subsolver": (
        "CHAIN_ID",
        "DISCOVERY_METHOD",
        "RPC_URL",
        "SUBSOLVER_PRIVATE_KEY",
        "TRAMPOLINE_FACTORY",
        "GPV2_SETTLEMENT",
    ),
    "binance-subsolver": (
        "CHAIN_ID",
        "DISCOVERY_METHOD",
        "RPC_URL",
        "SUBSOLVER_PRIVATE_KEY",
        "TRAMPOLINE_FACTORY",
        "BINANCE_API_KEY",
        "BINANCE_SECRET_KEY",
        "GPV2_SETTLEMENT",
    ),
}


class DeploymentError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise DeploymentError(message)


def name(value):
    require(
        isinstance(value, str) and re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,62}", value),
        "Invalid project name",
    )
    return value


def compose_project(project):
    return f"byos-{name(project)}"


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON key")
        result[key] = value
    return result


def read_json(path):
    return json.loads(path.read_text(), object_pairs_hook=unique_object)


def manifest(root):
    data = read_json(root / "deploy.json")
    require(
        isinstance(data, dict)
        and set(data) == {"projects"}
        and isinstance(data["projects"], dict),
        "Invalid manifest",
    )
    projects = {}
    for project, entry in data["projects"].items():
        name(project)
        require(
            isinstance(entry, dict) and set(entry) == {"services"},
            "Invalid project record",
        )
        services = entry["services"]
        require(
            isinstance(services, list)
            and all(
                isinstance(s, str) and s in SERVICES - {"postgres", "redis"}
                for s in services
            ),
            "Invalid services",
        )
        require(len(set(services)) == len(services), "Duplicate service")
        projects[project] = services + ["postgres", "redis"]
    # An explicit empty projects object is a valid request to remove all managed projects.
    return projects


def clean_env():
    # No ambient COMPOSE_*, passwords, ports, DOCKER_HOST, or root .env inheritance.
    return {
        key: os.environ[key]
        for key in ("PATH", "HOME", "DOCKER_CONFIG", "XDG_RUNTIME_DIR")
        if key in os.environ
    }


def run(args, *, env=None, capture=True):
    result = subprocess.run(
        args,
        check=False,
        env=env if env is not None else clean_env(),
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    if (
        result.returncode
        and "--no-env-resolution" in args
        and "unknown flag" in (result.stderr or "")
    ):
        raise DeploymentError(
            "Upgrade Docker Compose: config --no-env-resolution is required (v5 tested)"
        )
    # Docker diagnostics may embed a resolved configuration or secret; do not echo them.
    require(
        result.returncode == 0,
        f"{args[0]} command failed (exit {result.returncode}); inspect the host privately",
    )
    return result.stdout or ""


def atomic_json(path, data):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(data, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def checked_head(root):
    require(
        not run(
            ["git", "-C", str(root), "status", "--porcelain", "--untracked-files=no"]
        ).strip(),
        "Tracked checkout modifications block deployment",
    )
    return run(["git", "-C", str(root), "rev-parse", "HEAD"]).strip()


def image_info(tag):
    return json.loads(run(["docker", "image", "inspect", tag]))[0]


def build(root, state, sha):
    require(
        re.fullmatch(r"[0-9a-f]{40}", sha) and checked_head(root) == sha,
        "Build revision mismatch",
    )
    # Invalidate before the first build: a failed partial build is never deployable.
    (state / "build.json").unlink(missing_ok=True)
    record = {"sha": sha, "images": {}}
    for tag, dockerfile in IMAGES.items():
        run(
            [
                "docker",
                "build",
                "--label",
                f"{REVISION}={sha}",
                "-f",
                str(root / dockerfile),
                "-t",
                tag,
                str(root),
            ],
            capture=False,
        )
        info = image_info(tag)
        require(
            info["Config"].get("Labels", {}).get(REVISION) == sha,
            "Built image revision mismatch",
        )
        record["images"][tag] = info["Id"]
    atomic_json(state / "build.json", record)
    print(f"Built both images at {sha}", flush=True)


def provenance(root, state):
    record = read_json(state / "build.json")
    require(
        record["sha"] == checked_head(root) and set(record["images"]) == set(IMAGES),
        "Build record does not match checkout",
    )
    for tag, expected in record["images"].items():
        info = image_info(tag)
        require(
            info["Id"] == expected
            and info["Config"].get("Labels", {}).get(REVISION) == record["sha"],
            "Image provenance mismatch; rebuild both images",
        )
    return record


def resolve(root, project, selected):
    directory = root / "env" / name(project)
    require(
        directory.is_dir()
        and not directory.is_symlink()
        and not (root / "env").is_symlink(),
        f"{project}: missing or linked env directory",
    )
    for filename in [".env"] + [
        f".env.{service}"
        for service in selected
        if service not in ("postgres", "redis")
    ]:
        path = directory / filename
        require(
            path.is_file() and not path.is_symlink(),
            f"{project}: missing or linked {filename}",
        )
    # --no-env-resolution lets inactive services lack their env files. Filter those
    # services before asking Compose to resolve active env files and dependencies.
    environment = {**clean_env(), "PROJECT": project}
    args = [
        "docker",
        "compose",
        "--project-directory",
        str(root),
        "--env-file",
        str(directory / ".env"),
        "-p",
        compose_project(project),
        "-f",
        str(root / "docker-compose.prod-local.yml"),
    ]
    raw = json.loads(
        run(
            [*args, "config", "--no-env-resolution", "--format", "json"],
            env=environment,
        )
    )
    require(
        set(selected) <= set(raw["services"]), f"{project}: unknown Compose service"
    )
    raw["services"] = {s: raw["services"][s] for s in selected}
    for service, config in raw["services"].items():
        require(
            set(config.get("depends_on", {})) <= set(selected),
            f"{project}/{service}: declare all dependencies in manifest",
        )
    # Resolve the same filtered model, without ambient variables or a root .env.
    with tempfile.TemporaryDirectory() as temporary:
        model = Path(temporary) / "compose.json"
        atomic_json(model, raw)
        rendered = json.loads(
            run(
                [
                    "docker",
                    "compose",
                    "--project-directory",
                    str(root),
                    "--env-file",
                    str(directory / ".env"),
                    "-p",
                    compose_project(project),
                    "-f",
                    str(model),
                    "config",
                    "--format",
                    "json",
                ],
                env=environment,
            )
        )
    for service, config in rendered["services"].items():
        env = config.get("environment", {})
        for key in REQUIRED.get(service, ()):
            require(bool(env.get(key)), f"{project}/{service}: missing {key}")
        if service.endswith("-subsolver"):
            key = (
                "SUBSOLVER_BEARER"
                if env.get("DISCOVERY_METHOD") == "solve"
                else "DISCOVERY_URL"
            )
            require(bool(env.get(key)), f"{project}/{service}: missing {key}")
        for binding in config.get("ports", []):
            require(
                binding.get("published")
                and str(binding["published"]).isdigit()
                and 0 < int(binding["published"]) < 65536,
                f"{project}/{service}: invalid host port",
            )
            listener = (
                env.get("SOLVE_PORT", "3001")
                if service.endswith("-subsolver")
                else None
            )
            if listener:
                require(
                    str(binding["target"]) == str(listener),
                    f"{project}/{service}: SOLVE_PORT must match Compose target",
                )
    # Validate explicit shared port settings rather than silently accepting defaults.
    resolved_env = run(
        [*args, "config", "--no-env-resolution", "--environment"], env=environment
    )
    values = dict(
        line.split("=", 1) for line in resolved_env.splitlines() if "=" in line
    )
    for key in (
        ["POSTGRES_PASSWORD", "REDIS_PASSWORD"]
        + [PORTS[s] for s in selected]
        + (["BYOS_INTERNAL_HOST_PORT"] if "byos" in selected else [])
    ):
        require(bool(values.get(key)), f"{project}: missing {key}")
    for key in ("POSTGRES_PASSWORD", "REDIS_PASSWORD"):
        require(
            re.fullmatch(r"[A-Za-z0-9._~-]+", values[key]),
            f"{project}: {key} must use URL-safe characters",
        )
    return rendered


def bindings(config):
    for service, entry in config["services"].items():
        for binding in entry.get("ports", []):
            yield (
                service,
                binding.get("host_ip", "0.0.0.0"),
                int(binding["published"]),
                binding.get("protocol", "tcp"),
            )


def overlaps(left, right):
    return (
        left == right or left in ("0.0.0.0", "::", "") or right in ("0.0.0.0", "::", "")
    )


def validate_ports(configs):
    seen = []
    for project, config in configs.items():
        for service, host, port, protocol in bindings(config):
            for (
                other_project,
                other_service,
                other_host,
                other_port,
                other_protocol,
            ) in seen:
                require(
                    not (
                        port == other_port
                        and protocol == other_protocol
                        and overlaps(host, other_host)
                    ),
                    f"Port conflict: {project}/{service} and {other_project}/{other_service}",
                )
            seen.append((project, service, host, port, protocol))
    containers = []
    ids = run(["docker", "container", "ls", "--all", "--quiet"]).split()
    if ids:
        containers = json.loads(run(["docker", "container", "inspect", *ids]))
    for project, service, host, port, protocol in seen:
        owners = []
        for container in containers:
            if not container.get("State", {}).get("Running", True):
                continue
            for key, published in (
                container.get("NetworkSettings", {}).get("Ports") or {}
            ).items():
                for binding in published or []:
                    if (
                        key.endswith("/" + protocol)
                        and int(binding["HostPort"]) == port
                        and overlaps(host, binding.get("HostIp", "0.0.0.0"))
                    ):
                        labels = container["Config"].get("Labels") or {}
                        require(
                            labels.get("com.docker.compose.project")
                            == compose_project(project)
                            and labels.get("com.docker.compose.service") == service,
                            f"{project}/{service}: port {port} occupied by another container",
                        )
                        owners.append(container["Id"])
        if owners:
            continue
        family = socket.AF_INET6 if ":" in host else socket.AF_INET
        kind = socket.SOCK_DGRAM if protocol == "udp" else socket.SOCK_STREAM
        with socket.socket(family, kind) as probe:
            try:
                probe.bind((host, port))
            except OSError:
                raise DeploymentError(
                    f"{project}/{service}: port {port} occupied on host"
                ) from None

    return containers


def validate_existing_volumes(configs, containers):
    # A matching project can predate this system. Never replace its mounted data
    # with fresh default volumes merely because the logical project name changed.
    for project, config in configs.items():
        for container in containers:
            labels = container["Config"].get("Labels") or {}
            if labels.get("com.docker.compose.project") != compose_project(project):
                continue
            service = labels.get("com.docker.compose.service")
            if service not in config["services"]:
                continue
            mounted = {
                entry["Destination"]: entry for entry in container.get("Mounts", [])
            }
            for volume in config["services"][service].get("volumes", []):
                if volume.get("type") != "volume" or not volume.get("source"):
                    continue
                old = mounted.get(volume["target"])
                if not old:
                    continue
                expected = config["volumes"][volume["source"]]["name"]
                variable = {
                    "postgres-data": "POSTGRES_VOLUME_NAME",
                    "redis-data": "REDIS_VOLUME_NAME",
                }.get(volume["source"], "the volume configuration")
                require(
                    old.get("Type") == "volume" and old.get("Name") == expected,
                    f"{project}/{service}: existing data mount differs from {expected}; configure {variable} to preserve it before deployment",
                )


def compose(config, *args, capture=True):
    with tempfile.TemporaryDirectory() as temporary:
        path = Path(temporary) / "compose.json"
        atomic_json(path, config)
        run(
            [
                "docker",
                "compose",
                "--env-file",
                "/dev/null",
                "-p",
                config["name"],
                "-f",
                str(path),
                *args,
            ],
            capture=capture,
        )


def deploy(root, state, args, check_only=False):
    require(
        args and (args == ["--all"] or not args[0].startswith("-")),
        "Usage: deploy <project> [services...] | --all",
    )
    record = None if check_only else provenance(root, state)
    desired = manifest(root)
    saved = (
        read_json(state / "applied.json")
        if (state / "applied.json").exists()
        else {"projects": {}}
    )
    configs = {
        project: resolve(root, project, services)
        for project, services in desired.items()
    }
    containers = validate_ports(configs)
    if not check_only:
        for project, previous in saved["projects"].items():
            if project in desired:
                require(
                    previous["config"]["name"] == compose_project(project),
                    f"{project}: saved deployment uses a different Compose project; migrate it explicitly before deployment",
                )
        validate_existing_volumes(configs, containers)
    targets = list(desired) if args == ["--all"] else [name(args[0])]
    if args != ["--all"]:
        require(targets[0] in desired, "Project is not declared in manifest")
        require(
            all(s in desired[targets[0]] for s in args[1:]),
            "Selected service is not declared",
        )
    if check_only:
        print("All declared project configurations and ports passed preflight")
        return
    # Pin both mutable :local tags to verified image IDs in the resolved model.
    for config in configs.values():
        for entry in config["services"].values():
            if entry.get("image") in record["images"]:
                entry["image"] = record["images"][entry["image"]]
    for project in targets:
        config = configs[project]
        previous = saved["projects"].get(project)
        selected = (
            list(config["services"])
            if args == ["--all"] or len(args) == 1
            else args[1:]
        )
        # A crash after Compose partially creates containers must still leave enough
        # metadata to reconcile them. Keep old services until explicitly removed.
        recovery = copy.deepcopy(config)
        if previous:
            recovery["services"] = {
                **previous["config"]["services"],
                **config["services"],
            }
        saved["projects"][project] = {
            "config": recovery,
            "sha": record["sha"],
            "status": "applying",
        }
        atomic_json(state / "applied.json", saved)
        if args == ["--all"] and previous:
            removed = sorted(
                set(previous["config"]["services"]) - set(config["services"])
            )
            if removed:
                compose(previous["config"], "rm", "--stop", "--force", *removed)
        compose(
            config,
            "up",
            "--detach",
            "--wait",
            "--wait-timeout",
            "240",
            "--no-build",
            *selected,
        )
        if args == ["--all"]:
            saved["projects"][project]["config"] = config
        saved["projects"][project]["status"] = (
            "applied" if len(selected) == len(config["services"]) else "partial"
        )
        atomic_json(state / "applied.json", saved)
        print(f"Deployed {project} at {record['sha']}", flush=True)
    if args == ["--all"]:
        for project in sorted(set(saved["projects"]) - set(desired)):
            compose(saved["projects"][project]["config"], "down", "--remove-orphans")
            del saved["projects"][project]
            atomic_json(state / "applied.json", saved)
            print(f"Removed managed project {project}; volumes preserved", flush=True)
        atomic_json(
            state / "last-release.json", {"sha": record["sha"], "projects": desired}
        )


def delete_env(root, project):
    name(project)
    base = root / "env"
    target = base / project
    require(
        not base.is_symlink()
        and not target.is_symlink()
        and target.resolve().parent == base.resolve(),
        "Env path escapes deployment directory",
    )
    require(target.is_dir(), "Remote project env directory does not exist")
    shutil.rmtree(target)
    print(f"Deleted env/{project}; containers and manifest unchanged")


def main():
    state = Path(sys.argv[1])
    mode, *args = sys.argv[2:]
    root = Path.cwd()
    os.umask(0o077)
    if mode in ("build", "release"):
        require(
            len(args) == (2 if mode == "release" else 1),
            "Usage: release <sha> --all | build [sha]",
        )
        require(mode != "release" or args[1] == "--all", "Release requires --all")
        build(root, state, args[0])
        if mode == "release":
            deploy(root, state, ["--all"])
    elif mode in ("deploy", "check-ports"):
        deploy(
            root,
            state,
            args or (["--all"] if mode == "check-ports" else []),
            check_only=mode == "check-ports",
        )
    elif mode == "delete-remote-env":
        require(len(args) == 1, "Usage: delete-remote-env <project>")
        delete_env(root, args[0])
    elif mode == "logs":
        require(args, "Usage: logs <project> [service] [--tail N]")
        project = name(args[0])
        saved = read_json(state / "applied.json")["projects"]
        require(project in saved, "Project has no managed deployment")
        extra = args[1:]
        if "--tail" in extra:
            index = extra.index("--tail")
            require(
                index + 1 < len(extra) and extra[index + 1].isdigit(),
                "Invalid --tail count",
            )
            del extra[index : index + 2]
        require(
            all(s in saved[project]["config"]["services"] for s in extra),
            "Unknown log service",
        )
        # Streaming logs must not hold up releases. Unlock the inherited bootstrap fd.
        import fcntl

        fcntl.flock(9, fcntl.LOCK_UN)
        compose(saved[project]["config"], "logs", "--follow", *args[1:], capture=False)
    else:
        raise DeploymentError("Unknown server command")


if __name__ == "__main__":
    try:
        main()
    except (DeploymentError, OSError, ValueError, KeyError, TypeError) as error:
        # JSON errors include line positions, never raw contents.
        print(f"Deployment failed: {error}", file=sys.stderr)
        sys.exit(1)
