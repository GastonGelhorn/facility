import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";
import { DockerWorkspaceRuntime } from "../src/workspaces/docker.js";
import type { WorkspaceCommand, WorkspaceLocator } from "../src/workspaces/runtime.js";

const id = "ws_0123456789abcdef";
const suffix = createHash("sha256").update(id).digest("hex").slice(0, 24);
const workspace: WorkspaceLocator = {
  id,
  image: "facility-runner:test",
  externalRef: `facility-ws-${suffix}`,
  volumeRef: `facility-ws-volume-${suffix}`,
  environment: { GITHUB_TOKEN: "must-not-reach-the-probe" },
  ports: [{ service: "app", port: 3_000 }],
};

function containerInfo(running: boolean, labels = { "facility.workspace.id": id }) {
  return {
    Id: "container-original",
    State: { Running: running, Status: running ? "running" : "exited" },
    Config: { Labels: { "facility.workload.kind": "workspace-v2", ...labels } },
    Mounts: [{ Destination: "/workspace", Name: workspace.volumeRef }],
  };
}

function fakeDocker(container?: ReturnType<typeof containerInfo>, volume = true) {
  const start = vi.fn();
  const notFound = Object.assign(new Error("not found"), { statusCode: 404 });
  const docker = {
    getContainer: vi.fn(() => ({
      inspect: async () => {
        if (!container) throw notFound;
        return container;
      },
      start,
    })),
    getVolume: vi.fn(() => ({
      inspect: async () => {
        if (!volume) throw notFound;
        return {};
      },
    })),
  };
  return { docker: docker as unknown as Docker, start };
}

/** Run the real probe on this machine, the way `docker exec` would inside the workspace. */
function runProbeLocally(_target: WorkspaceLocator, command: WorkspaceCommand) {
  const stdout = execFileSync(process.execPath, command.args ?? [], {
    encoding: "utf8",
    timeout: 5_000,
    env: { ...process.env, SECRET: "must-not-leak" },
  });
  return Promise.resolve({ exitCode: 0, stdout, stderr: "", durationMs: 1 });
}

describe("Docker workspace diagnostics", () => {
  it("probes the running container it inspected, without waking it or passing workspace secrets", async () => {
    const { docker, start } = fakeDocker(containerInfo(true));
    const runtime = new DockerWorkspaceRuntime(docker);
    const exec = vi.spyOn(runtime, "exec").mockImplementation(runProbeLocally);

    const result = await runtime.diagnostics(workspace, process.cwd(), AbortSignal.timeout(8_000));

    expect(result).toMatchObject({
      provider: "docker",
      state: "running",
      computeRef: "container-original",
      probe: "ok",
    });
    expect(result.health?.gitHead).toMatch(/^[a-f0-9]{40}$/);
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(JSON.stringify(result)).not.toContain(process.cwd());
    expect(exec).toHaveBeenCalledOnce();
    const [target, command] = exec.mock.calls[0] ?? [];
    expect(target).toMatchObject({ expectedComputeRef: "container-original", ports: [] });
    expect(target).not.toHaveProperty("environment");
    expect(command).toMatchObject({ command: "node", resume: false, timeoutMs: 5_000 });
    expect(start).not.toHaveBeenCalled();
  });

  it("reports stopped compute without starting it or running a command", async () => {
    const { docker, start } = fakeDocker(containerInfo(false));
    const runtime = new DockerWorkspaceRuntime(docker);
    const exec = vi.spyOn(runtime, "exec");

    await expect(
      runtime.diagnostics(workspace, "/workspace/repos/app", AbortSignal.timeout(8_000)),
    ).resolves.toEqual({ provider: "docker", state: "sleeping", computeRef: "container-original" });
    expect(exec).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it.each([
    [true, "sleeping"],
    [false, "destroyed"],
  ])("without a container, reports %s volume as %s", async (volume, state) => {
    const { docker } = fakeDocker(undefined, volume);
    const runtime = new DockerWorkspaceRuntime(docker);
    const exec = vi.spyOn(runtime, "exec");

    await expect(
      runtime.diagnostics(workspace, "/workspace/repos/app", AbortSignal.timeout(8_000)),
    ).resolves.toEqual({ provider: "docker", state });
    expect(exec).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a failed probe, even with parseable output",
      () => Promise.resolve({ exitCode: 1, stdout: '{"oomKills":0}', stderr: "", durationMs: 1 }),
    ],
    [
      "unbounded output",
      () => Promise.resolve({ exitCode: 0, stdout: " ".repeat(8_193), stderr: "", durationMs: 1 }),
    ],
    [
      "telemetry outside the schema",
      () => Promise.resolve({ exitCode: 0, stdout: '{"oomKills":-1}', stderr: "", durationMs: 1 }),
    ],
    ["a command error", () => Promise.reject(new Error("workspace_command_timeout"))],
  ])("marks the probe unavailable after %s", async (_case, outcome) => {
    const { docker } = fakeDocker(containerInfo(true));
    const runtime = new DockerWorkspaceRuntime(docker);
    vi.spyOn(runtime, "exec").mockImplementation(outcome);

    await expect(
      runtime.diagnostics(workspace, "/workspace/repos/app", AbortSignal.timeout(8_000)),
    ).resolves.toEqual({
      provider: "docker",
      state: "running",
      computeRef: "container-original",
      probe: "unavailable",
    });
  });

  it("refuses to probe a container owned by another workspace", async () => {
    const { docker } = fakeDocker(containerInfo(true, { "facility.workspace.id": "ws_other" }));
    const runtime = new DockerWorkspaceRuntime(docker);
    const exec = vi.spyOn(runtime, "exec");

    await expect(
      runtime.diagnostics(workspace, "/workspace/repos/app", AbortSignal.timeout(8_000)),
    ).rejects.toMatchObject({ code: "workspace_ownership_mismatch" });
    expect(exec).not.toHaveBeenCalled();
  });
});
