"""Release safety regressions. No SSH, real secrets, or running containers."""

import contextlib
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server

ROOT = Path(__file__).resolve().parents[2]


def config(project, services=("postgres", "redis", "byos"), port=None):
    entries = {
        s: {"image": "byos-service:local" if s == "byos" else s} for s in services
    }
    if port:
        entries["byos"]["ports"] = [{"published": str(port), "target": 9585}]
    return {"name": f"byos-{project}", "services": entries}


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / "state"
        self.state.mkdir()
        self.sha = "a" * 40
        self.record = {
            "sha": self.sha,
            "images": {
                "byos-service:local": "sha256:service",
                "byos-admin:local": "sha256:admin",
            },
        }
        self.write_manifest(
            {"prod": {"services": ["byos"]}, "staging": {"services": ["byos"]}}
        )

    def write_manifest(self, projects):
        (self.root / "deploy.json").write_text(json.dumps({"projects": projects}))

    def save(self, projects):
        server.atomic_json(
            self.state / "applied.json",
            {
                "projects": {
                    p: {"config": c, "status": "applied"} for p, c in projects.items()
                }
            },
        )

    def deploy(self, args, compose=None):
        with (
            patch.object(server, "provenance", return_value=self.record),
            patch.object(
                server,
                "resolve",
                side_effect=lambda root, project, services: config(project, services),
            ),
            patch.object(server, "validate_ports"),
            patch.object(server, "compose", side_effect=compose) as calls,
            contextlib.redirect_stdout(io.StringIO()),
        ):
            server.deploy(self.root, self.state, args)
            return calls

    def test_multiple_project_records_preserve_service_lists(self):
        self.write_manifest(
            {
                "prod": {"services": ["byos", "admin"]},
                "staging": {"services": ["byos", "fynd"]},
            }
        )
        self.assertEqual(
            server.manifest(self.root)["prod"], ["byos", "admin", "postgres", "redis"]
        )
        self.assertEqual(
            server.manifest(self.root)["staging"], ["byos", "fynd", "postgres", "redis"]
        )

    def test_invalid_manifest_and_duplicate_keys_fail(self):
        for text in [
            "{}",
            '{"projects":{"../escape":{"services":[]}}}',
            '{"projects":{},"projects":{}}',
            '{"projects":{"prod":{"services":["unknown"]}}}',
            '{"projects":{"prod":{"services":["byos","byos"]}}}',
        ]:
            with self.subTest(text=text):
                (self.root / "deploy.json").write_text(text)
                with self.assertRaises((server.DeploymentError, ValueError)):
                    server.manifest(self.root)

    def test_preflight_failure_never_mutates_containers_or_applied_state(self):
        self.save({"removed": config("removed")})
        before = (self.state / "applied.json").read_bytes()
        with (
            patch.object(server, "provenance", return_value=self.record),
            patch.object(
                server, "resolve", side_effect=server.DeploymentError("missing env")
            ),
            patch.object(server, "compose") as compose,
        ):
            with self.assertRaises(server.DeploymentError):
                server.deploy(self.root, self.state, ["--all"])
            compose.assert_not_called()
        self.assertEqual(before, (self.state / "applied.json").read_bytes())

    def test_full_manifest_removes_only_managed_projects_and_preserves_volumes(self):
        self.save({"removed": config("removed"), "prod": config("prod")})
        calls = self.deploy(["--all"])
        down = [call for call in calls.call_args_list if "down" in call.args]
        self.assertEqual(len(down), 1)
        self.assertEqual(down[0].args[0]["name"], "byos-removed")
        self.assertNotIn("-v", down[0].args)
        self.assertNotIn(
            "removed", server.read_json(self.state / "applied.json")["projects"]
        )
        self.assertTrue((self.state / "last-release.json").exists())

    def test_removed_service_is_stopped_without_down_of_retained_project(self):
        self.save({"prod": config("prod", ["postgres", "redis", "byos", "admin"])})
        calls = self.deploy(["--all"])
        remove = [call.args for call in calls.call_args_list if "rm" in call.args]
        self.assertEqual(remove[0][1:], ("rm", "--stop", "--force", "admin"))
        self.assertFalse(any("down" in call.args for call in calls.call_args_list))

    def test_manual_selection_does_not_remove_projects_or_services(self):
        self.save(
            {
                "removed": config("removed"),
                "prod": config("prod", ["postgres", "redis", "byos", "admin"]),
            }
        )
        calls = self.deploy(["prod", "byos"])
        self.assertEqual(len(calls.call_args_list), 1)
        self.assertEqual(calls.call_args.args[-1], "byos")
        state = server.read_json(self.state / "applied.json")["projects"]
        self.assertIn("removed", state)
        self.assertIn("admin", state["prod"]["config"]["services"])
        self.assertFalse((self.state / "last-release.json").exists())

    def test_partial_failure_keeps_recovery_state_and_previous_release(self):
        server.atomic_json(self.state / "last-release.json", {"sha": "previous"})
        counter = 0

        def fail_second(*args):
            nonlocal counter
            counter += 1
            if counter == 2:
                raise server.DeploymentError("compose failed")

        with self.assertRaises(server.DeploymentError):
            self.deploy(["--all"], fail_second)
        projects = server.read_json(self.state / "applied.json")["projects"]
        self.assertEqual(projects["prod"]["status"], "applied")
        self.assertEqual(projects["staging"]["status"], "applying")
        self.assertEqual(
            server.read_json(self.state / "last-release.json")["sha"], "previous"
        )
        self.deploy(["--all"])
        self.assertEqual(
            server.read_json(self.state / "last-release.json")["sha"], self.sha
        )

    def test_deploy_pins_local_image_ids(self):
        calls = self.deploy(["prod"])
        self.assertEqual(
            calls.call_args.args[0]["services"]["byos"]["image"], "sha256:service"
        )

    def test_failed_second_build_invalidates_old_record(self):
        server.atomic_json(self.state / "build.json", self.record)
        builds = 0

        def run(args, **kwargs):
            nonlocal builds
            builds += 1
            if builds == 2:
                raise server.DeploymentError("failed second build")

        with (
            patch.object(server, "checked_head", return_value=self.sha),
            patch.object(server, "run", side_effect=run),
            patch.object(
                server,
                "image_info",
                return_value={
                    "Id": "id",
                    "Config": {"Labels": {server.REVISION: self.sha}},
                },
            ),
        ):
            with self.assertRaises(server.DeploymentError):
                server.build(self.root, self.state, self.sha)
        self.assertFalse((self.state / "build.json").exists())

    def test_provenance_rejects_moving_tag_or_checkout(self):
        server.atomic_json(self.state / "build.json", self.record)
        with (
            patch.object(server, "checked_head", return_value=self.sha),
            patch.object(
                server,
                "image_info",
                return_value={
                    "Id": "wrong",
                    "Config": {"Labels": {server.REVISION: self.sha}},
                },
            ),
        ):
            with self.assertRaises(server.DeploymentError):
                server.provenance(self.root, self.state)
        with patch.object(server, "checked_head", return_value="b" * 40):
            with self.assertRaises(server.DeploymentError):
                server.provenance(self.root, self.state)

    def test_existing_prefixed_container_owns_port_without_saved_state(self):
        container = {
            "Id": "existing",
            "Config": {
                "Labels": {
                    "com.docker.compose.project": "byos-prod",
                    "com.docker.compose.service": "byos",
                }
            },
            "NetworkSettings": {
                "Ports": {"9585/tcp": [{"HostPort": "20000", "HostIp": "0.0.0.0"}]}
            },
        }
        with patch.object(
            server, "run", side_effect=["existing", json.dumps([container])]
        ):
            server.validate_ports({"prod": config("prod", port=20000)})

    def test_cross_project_ports_conflict_before_host_checks(self):
        with patch.object(server, "run") as run:
            with self.assertRaisesRegex(server.DeploymentError, "Port conflict"):
                server.validate_ports(
                    {
                        "prod": config("prod", port=20000),
                        "staging": config("staging", port=20000),
                    },
                )
            run.assert_not_called()

    def test_host_occupancy_and_exact_compose_label_ownership(self):
        import socket

        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
            with patch.object(server, "run", return_value=""):
                with self.assertRaisesRegex(server.DeploymentError, "occupied on host"):
                    server.validate_ports({"prod": config("prod", port=port)})
        container = {
            "Id": "id",
            "Config": {
                "Labels": {
                    "com.docker.compose.project": "byos-prod-pretender",
                    "com.docker.compose.service": "byos",
                }
            },
            "NetworkSettings": {
                "Ports": {"9585/tcp": [{"HostPort": "20000", "HostIp": "0.0.0.0"}]}
            },
        }
        with patch.object(server, "run", side_effect=["id", json.dumps([container])]):
            with self.assertRaisesRegex(server.DeploymentError, "another container"):
                server.validate_ports({"prod": config("prod", port=20000)})

    def test_delete_env_confines_paths_and_does_not_touch_manifest_or_containers(self):
        target = self.root / "env" / "prod"
        target.mkdir(parents=True)
        (target / ".env").write_text("secret")
        before = (self.root / "deploy.json").read_bytes()
        with (
            patch.object(server, "compose") as compose,
            contextlib.redirect_stdout(io.StringIO()),
        ):
            server.delete_env(self.root, "prod")
            compose.assert_not_called()
        self.assertFalse(target.exists())
        self.assertEqual(before, (self.root / "deploy.json").read_bytes())
        target.symlink_to(self.state, target_is_directory=True)
        for name in ["prod", "../state", "/tmp", "-prod"]:
            with self.subTest(name=name), self.assertRaises(server.DeploymentError):
                server.delete_env(self.root, name)

    def test_prefixed_project_with_wrong_service_cannot_claim_port(self):
        container = {
            "Id": "existing",
            "Config": {
                "Labels": {
                    "com.docker.compose.project": "byos-prod",
                    "com.docker.compose.service": "admin",
                }
            },
            "NetworkSettings": {
                "Ports": {"9585/tcp": [{"HostPort": "20000", "HostIp": "0.0.0.0"}]}
            },
        }
        with patch.object(
            server, "run", side_effect=["existing", json.dumps([container])]
        ):
            with self.assertRaisesRegex(server.DeploymentError, "another container"):
                server.validate_ports({"prod": config("prod", port=20000)})

    def test_existing_volume_mismatch_blocks_deployment_before_state_or_compose(self):
        rendered = config("prod")
        rendered["services"]["postgres"]["volumes"] = [
            {
                "type": "volume",
                "source": "postgres-data",
                "target": "/var/lib/postgresql/data",
            }
        ]
        rendered["volumes"] = {"postgres-data": {"name": "byos-prod_postgres-data"}}
        container = {
            "Config": {
                "Labels": {
                    "com.docker.compose.project": "byos-prod",
                    "com.docker.compose.service": "postgres",
                }
            },
            "Mounts": [
                {
                    "Type": "volume",
                    "Name": "legacy_postgres-data",
                    "Destination": "/var/lib/postgresql/data",
                }
            ],
        }
        self.write_manifest({"prod": {"services": ["byos"]}})
        with (
            patch.object(server, "provenance", return_value=self.record),
            patch.object(server, "resolve", return_value=rendered),
            patch.object(server, "validate_ports", return_value=[container]),
            patch.object(server, "compose") as compose,
        ):
            with self.assertRaisesRegex(server.DeploymentError, "POSTGRES_VOLUME_NAME"):
                server.deploy(self.root, self.state, ["--all"])
            compose.assert_not_called()
            self.assertFalse((self.state / "applied.json").exists())
            # An explicit name for the old data is safe to reuse.
            rendered["volumes"]["postgres-data"]["name"] = "legacy_postgres-data"
            with contextlib.redirect_stdout(io.StringIO()):
                server.deploy(self.root, self.state, ["--all"])
            compose.assert_called_once()

    def test_saved_unprefixed_project_requires_explicit_migration(self):
        old = config("prod")
        old["name"] = "prod"
        self.save({"prod": old})
        before = (self.state / "applied.json").read_bytes()
        with self.assertRaisesRegex(server.DeploymentError, "migrate it explicitly"):
            self.deploy(["--all"])
        self.assertEqual((self.state / "applied.json").read_bytes(), before)

    def test_preflight_does_not_adopt_or_remove_existing_projects(self):
        with (
            patch.object(
                server,
                "resolve",
                side_effect=lambda root, project, services: config(project, services),
            ),
            patch.object(server, "validate_ports", return_value=[]),
            patch.object(server, "compose") as compose,
            contextlib.redirect_stdout(io.StringIO()),
        ):
            server.deploy(self.root, self.state, ["--all"], check_only=True)
            compose.assert_not_called()
            self.assertFalse((self.state / "applied.json").exists())

    def test_state_permissions(self):
        server.atomic_json(self.state / "applied.json", {"secret": "dummy"})
        self.assertEqual((self.state / "applied.json").stat().st_mode & 0o777, 0o600)


@unittest.skipUnless(
    shutil.which("docker"), "Docker Compose CLI required; daemon not needed"
)
class ComposeResolutionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        shutil.copy(ROOT / "docker-compose.prod-local.yml", self.root)
        for index, project in enumerate(("prod", "staging")):
            directory = self.root / "env" / project
            directory.mkdir(parents=True)
            keys = [
                "POSTGRES_HOST_PORT",
                "REDIS_HOST_PORT",
                "BYOS_PUBLIC_HOST_PORT",
                "BYOS_INTERNAL_HOST_PORT",
            ]
            shared = f"POSTGRES_PASSWORD={project}password\nREDIS_PASSWORD={project}password\n"
            shared += "\n".join(
                f"{key}={30000 + index * 10 + n}" for n, key in enumerate(keys)
            )
            (directory / ".env").write_text(shared + "\n")
            (directory / ".env.byos").write_text(
                "\n".join(f"{key}=dummy" for key in server.REQUIRED["byos"])
                + "\nDUMMY_SECRET='literal$dollar'\n"
            )

    def test_isolated_resolution_ignores_ambient_values_and_inactive_env_files(self):
        with patch.dict(
            os.environ,
            {
                "POSTGRES_PASSWORD": "ambient",
                "BYOS_PUBLIC_HOST_PORT": "12345",
                "COMPOSE_FILE": "/does/not/exist",
            },
        ):
            for index, project in enumerate(("prod", "staging")):
                rendered = server.resolve(
                    self.root, project, ["postgres", "redis", "byos"]
                )
                self.assertEqual(
                    rendered["services"]["postgres"]["environment"][
                        "POSTGRES_PASSWORD"
                    ],
                    f"{project}password",
                )
                self.assertEqual(
                    rendered["services"]["byos"]["environment"]["DUMMY_SECRET"],
                    "literal$$dollar",
                )
                self.assertEqual(
                    int(rendered["services"]["byos"]["ports"][0]["published"]),
                    30002 + index * 10,
                )
                self.assertNotIn("admin", rendered["services"])
                self.assertEqual(rendered["name"], f"byos-{project}")
                self.assertEqual(
                    rendered["volumes"]["postgres-data"]["name"],
                    f"byos-{project}_postgres-data",
                )
                self.assertEqual(
                    rendered["volumes"]["redis-data"]["name"],
                    f"byos-{project}_redis-data",
                )
                # Compose canonical JSON is already escaped for another parse.
                model = self.root / "snapshot.json"
                server.atomic_json(model, rendered)
                roundtrip = json.loads(
                    server.run(
                        [
                            "docker",
                            "compose",
                            "--env-file",
                            "/dev/null",
                            "-f",
                            str(model),
                            "config",
                            "--format",
                            "json",
                        ]
                    )
                )
                self.assertEqual(roundtrip, rendered)
                self.assertIn(
                    "$$REDIS_PASSWORD",
                    rendered["services"]["redis"]["healthcheck"]["test"][1],
                )
                self.assertNotIn(
                    "$$$$REDIS_PASSWORD",
                    rendered["services"]["redis"]["healthcheck"]["test"][1],
                )

    def test_avalanche_projects_resolve_without_fynd_files_or_port_settings(self):
        declared = server.manifest(ROOT)
        expected = ["byos", "admin", "binance-subsolver", "postgres", "redis"]
        for index, project in enumerate(("avax-staging", "avax-prod")):
            self.assertEqual(declared[project], expected)
            directory = self.root / "env" / project
            directory.mkdir(parents=True)
            port_keys = [
                "POSTGRES_HOST_PORT",
                "REDIS_HOST_PORT",
                "BYOS_PUBLIC_HOST_PORT",
                "BYOS_INTERNAL_HOST_PORT",
                "ADMIN_HOST_PORT",
                "BINANCE_SUBSOLVER_HOST_PORT",
            ]
            shared = "POSTGRES_PASSWORD=dummy\nREDIS_PASSWORD=dummy\n"
            shared += "\n".join(
                f"{key}={32000 + index * 10 + offset}"
                for offset, key in enumerate(port_keys)
            )
            (directory / ".env").write_text(shared + "\n")
            for service in ("byos", "admin", "binance-subsolver"):
                values = {key: "dummy" for key in server.REQUIRED[service]}
                values.update(
                    {
                        "CHAIN_ID": "43114",
                        "DISCOVERY_METHOD": "solve",
                        "SUBSOLVER_BEARER": "dummy",
                        "SUBSOLVERS_ENDPOINTS": "http://binance-subsolver:3002/solve",
                    }
                )
                (directory / f".env.{service}").write_text(
                    "\n".join(f"{key}={value}" for key, value in values.items())
                )
            rendered = server.resolve(self.root, project, expected)
            self.assertEqual(rendered["name"], f"byos-{project}")
            self.assertEqual(set(rendered["services"]), set(expected))
            self.assertEqual(
                rendered["services"]["byos"]["environment"]["CHAIN_ID"], "43114"
            )
            self.assertEqual(
                rendered["services"]["binance-subsolver"]["environment"]["CHAIN_ID"],
                "43114",
            )
            self.assertEqual(
                rendered["volumes"]["postgres-data"]["name"],
                f"byos-{project}_postgres-data",
            )
            self.assertEqual(
                rendered["services"]["byos"]["environment"]["SUBSOLVERS_ENDPOINTS"],
                "http://binance-subsolver:3002/solve",
            )
            self.assertFalse((directory / ".env.fynd").exists())

    def test_subsolver_healthchecks_probe_their_own_listener_ports(self):
        directory = self.root / "env/prod"
        with (directory / ".env").open("a") as stream:
            stream.write(
                "FYND_HOST_PORT=30100\nFYND_SUBSOLVER_HOST_PORT=30101\nBINANCE_SUBSOLVER_HOST_PORT=30102\n"
            )
        (directory / ".env.fynd").write_text("")
        for service in ("fynd-subsolver", "binance-subsolver"):
            values = {key: "dummy" for key in server.REQUIRED[service]}
            values.update(
                {"DISCOVERY_METHOD": "orderbook", "DISCOVERY_URL": "http://orders"}
            )
            (directory / f".env.{service}").write_text(
                "\n".join(f"{key}={value}" for key, value in values.items())
            )
        rendered = server.resolve(
            self.root,
            "prod",
            [
                "postgres",
                "redis",
                "byos",
                "fynd",
                "fynd-subsolver",
                "binance-subsolver",
            ],
        )
        for service, port in (("fynd-subsolver", 3001), ("binance-subsolver", 3002)):
            entry = rendered["services"][service]
            self.assertFalse(entry["healthcheck"].get("disable", False))
            self.assertEqual(
                entry["healthcheck"]["test"],
                ["CMD", "wget", "-qO-", f"http://127.0.0.1:{port}/healthz"],
            )
            self.assertEqual(entry["ports"][0]["target"], port)

    def test_compose_file_adds_prefix_without_cli_project_override(self):
        environment = {**server.clean_env(), "PROJECT": "prod"}
        rendered = json.loads(
            server.run(
                [
                    "docker",
                    "compose",
                    "--env-file",
                    str(self.root / "env/prod/.env"),
                    "-f",
                    str(self.root / "docker-compose.prod-local.yml"),
                    "config",
                    "--no-env-resolution",
                    "--format",
                    "json",
                ],
                env=environment,
            )
        )
        self.assertEqual(rendered["name"], "byos-prod")

    def test_explicit_legacy_volume_names_override_defaults(self):
        path = self.root / "env/staging/.env"
        with path.open("a") as stream:
            stream.write(
                "POSTGRES_VOLUME_NAME=byos-prod-local_postgres-data\nREDIS_VOLUME_NAME=byos-prod-local_redis-data\n"
            )
        rendered = server.resolve(self.root, "staging", ["postgres", "redis", "byos"])
        self.assertEqual(rendered["name"], "byos-staging")
        self.assertEqual(
            rendered["volumes"]["postgres-data"]["name"],
            "byos-prod-local_postgres-data",
        )
        self.assertEqual(
            rendered["volumes"]["redis-data"]["name"], "byos-prod-local_redis-data"
        )

    def test_omitted_shared_value_cannot_inherit_previous_project_or_shell(self):
        server.resolve(self.root, "prod", ["postgres", "redis", "byos"])
        path = self.root / "env/staging/.env"
        path.write_text(
            path.read_text().replace("POSTGRES_PASSWORD=stagingpassword\n", "")
        )
        with (
            patch.dict(os.environ, {"POSTGRES_PASSWORD": "ambient"}),
            self.assertRaises(server.DeploymentError),
        ):
            server.resolve(self.root, "staging", ["postgres", "redis", "byos"])

    def test_missing_explicit_port_or_required_service_value_fails(self):
        path = self.root / "env/prod/.env"
        path.write_text(path.read_text().replace("BYOS_PUBLIC_HOST_PORT=30002", ""))
        with self.assertRaisesRegex(
            server.DeploymentError, "missing BYOS_PUBLIC_HOST_PORT"
        ):
            server.resolve(self.root, "prod", ["postgres", "redis", "byos"])

    def test_dependency_omission_fails(self):
        with self.assertRaisesRegex(server.DeploymentError, "dependencies"):
            server.resolve(self.root, "prod", ["byos"])


class LockTests(unittest.TestCase):
    def test_concurrent_bootstraps_cannot_overlap(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "checkout"
            scripts = root / "scripts/deployment"
            scripts.mkdir(parents=True)
            (scripts / "server.py").write_text(
                'import time\nfrom pathlib import Path\np=Path("events")\nwith p.open("a") as f: f.write("start\\n"); f.flush(); time.sleep(.2); f.write("end\\n")\n'
            )
            command = [
                "bash",
                str(ROOT / "scripts/deployment/remote-bootstrap.sh"),
                str(root),
                "deploy",
                "--all",
            ]
            first = subprocess.Popen(command)
            second = subprocess.Popen(command)
            self.assertEqual(first.wait(timeout=10), 0)
            self.assertEqual(second.wait(timeout=10), 0)
            self.assertEqual(
                (root / "events").read_text().splitlines(),
                ["start", "end", "start", "end"],
            )


class BootstrapRevisionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.origin = base / "origin.git"
        self.root = base / "checkout"
        self.state = base / ".byos-deployment-state"
        self.run_git("init", "--bare", "--quiet", str(self.origin))
        self.run_git("init", "--quiet", "-b", "main", str(self.root))
        self.run_git(
            "-C",
            str(self.root),
            "config",
            "user.email",
            "deployment-test@example.invalid",
        )
        self.run_git("-C", str(self.root), "config", "user.name", "Deployment Test")
        server_dir = self.root / "scripts/deployment"
        server_dir.mkdir(parents=True)
        (server_dir / "server.py").write_text("""import json, subprocess, sys
from pathlib import Path
sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
Path(sys.argv[1], 'bootstrap-result.json').write_text(json.dumps({'sha': sha, 'args': sys.argv[2:]}))
""")
        (self.root / "version").write_text("first")
        self.run_git("-C", str(self.root), "add", ".")
        self.run_git("-C", str(self.root), "commit", "--quiet", "-m", "first")
        self.first = self.run_git("-C", str(self.root), "rev-parse", "HEAD")
        self.run_git("-C", str(self.root), "remote", "add", "origin", str(self.origin))
        self.run_git("-C", str(self.root), "push", "--quiet", "-u", "origin", "main")
        (self.root / "version").write_text("second")
        self.run_git("-C", str(self.root), "commit", "--quiet", "-am", "second")
        self.second = self.run_git("-C", str(self.root), "rev-parse", "HEAD")
        self.run_git("-C", str(self.root), "push", "--quiet", "origin", "main")

    def run_git(self, *args):
        return subprocess.check_output(
            ["git", *args], text=True, stderr=subprocess.DEVNULL
        ).strip()

    def bootstrap(self, *args):
        return subprocess.run(
            [
                "bash",
                str(ROOT / "scripts/deployment/remote-bootstrap.sh"),
                str(self.root),
                *args,
            ],
            check=False,
            text=True,
            capture_output=True,
            timeout=10,
        )

    def test_release_checks_out_tested_sha_after_main_advances(self):
        result = self.bootstrap("release", self.first, "--all")
        self.assertEqual(result.returncode, 0, result.stderr)
        actual = server.read_json(self.state / "bootstrap-result.json")
        self.assertEqual(
            actual, {"sha": self.first, "args": ["release", self.first, "--all"]}
        )
        result = self.bootstrap("release", self.second, "--all")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            server.read_json(self.state / "bootstrap-result.json")["sha"], self.second
        )

    def test_manual_default_resolves_remote_main_once(self):
        self.run_git(
            "-C", str(self.root), "checkout", "--quiet", "--detach", self.first
        )
        result = self.bootstrap("build")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            server.read_json(self.state / "bootstrap-result.json")["sha"], self.second
        )
        self.assertIn(self.second, result.stdout)
        self.assertIn("no CI claim", result.stdout)

    def test_dirty_tracked_checkout_is_preserved_and_rejected(self):
        (self.root / "version").write_text("operator change")
        result = self.bootstrap("build", self.first)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.root / "version").read_text(), "operator change")
        self.assertFalse((self.state / "bootstrap-result.json").exists())


if __name__ == "__main__":
    unittest.main()
