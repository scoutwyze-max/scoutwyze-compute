import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AgentLogStore } from "./agentLog.js";

// scripts/outreach/run.mjs, resolved relative to this file rather than
// process.cwd() — this module can be imported from anywhere (tests
// included) without depending on where `node` was invoked from.
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTREACH_SCRIPT_PATH = join(__dirname, "..", "..", "scripts", "outreach", "run.mjs");

// Fixed, non-operator-editable args (2026-09-24, Robert: "fixed
// buttons only, no free-text commands") — deliberately not exposed as
// request parameters. Changing these is a code change, not a console
// input.
const OUTREACH_ARGS = ["--flavor", "bearer", "--max", "60"];

/**
 * Command-box backend for the one approved action: trigger
 * scripts/outreach/run.mjs. In-memory in-flight guard (not DB-backed)
 * — consistent with this app's existing single-process/single-machine
 * design (see fly.toml's own header comment); a second trigger while
 * one's running is refused rather than queued or run concurrently
 * against the same rate-limited GitHub API.
 *
 * scriptPath/args are constructor-injectable — production wiring
 * (index.ts) uses the real script; tests point this at a trivial local
 * script instead, the same "fake the real I/O" convention already used
 * throughout tests/helpers/ (FakeChainReader etc.) — this suite must
 * not make real GitHub API calls just by existing.
 */
export class OutreachRunner {
  private running = false;

  constructor(
    private readonly agentLog: AgentLogStore,
    private readonly scriptPath: string = OUTREACH_SCRIPT_PATH,
    private readonly args: string[] = OUTREACH_ARGS,
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  /** Fire-and-forget — returns immediately once the process is
   * spawned; completion is reported asynchronously via agent_log, not
   * this call's return value. Throws only if a run is already in
   * flight (caller turns that into a 409). */
  trigger(): { runId: string } {
    if (this.running) {
      throw new Error("an outreach run is already in progress");
    }
    this.running = true;
    const runId = randomUUID();
    this.agentLog.append("run_started", `Outreach discovery started (${this.args.join(" ")})`, runId);

    const child = spawn(process.execPath, [this.scriptPath, ...this.args], {
      cwd: join(__dirname, "..", ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      this.running = false;
      if (code === 0) {
        // The script's own final summary line ("N kit(s) written...")
        // — extracted rather than dumping the whole stderr stream into
        // the feed, which is mostly per-signal progress noise.
        const summaryLine = stderr.split("\n").find((line) => line.includes("kit(s) written"));
        this.agentLog.append("run_completed", summaryLine?.trim() || "Outreach discovery completed.", runId);
      } else {
        const lastLine = stderr.trim().split("\n").at(-1) || `exited with code ${code}`;
        this.agentLog.append("run_failed", `Outreach discovery failed: ${lastLine}`, runId);
      }
    });

    child.on("error", (err) => {
      this.running = false;
      this.agentLog.append("run_failed", `Outreach discovery failed to start: ${err.message}`, runId);
    });

    return { runId };
  }
}
