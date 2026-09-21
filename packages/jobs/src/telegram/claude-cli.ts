// Answering through the Claude Code CLI that is installed on this server, which authenticates with
// Raza's subscription instead of an API key (his decision, 2026-09-21). The child process runs with
// ANTHROPIC_API_KEY removed so it cannot silently fall back to per-token billing, and with every
// tool denied: this is text generation, not an agent. Nothing a person types in Telegram can reach
// the shell, the filesystem or the network through it.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

/** Every tool Claude Code ships with. A message from a chat must never be able to use one. */
const DENIED_TOOLS = [
  "Bash", "Edit", "Write", "Read", "Glob", "Grep", "Task", "Agent", "NotebookEdit", "WebFetch",
  "WebSearch", "TodoWrite", "Artifact", "Workflow", "Skill", "SendMessage", "Monitor", "KillShell",
  "BashOutput", "SlashCommand", "ExitPlanMode", "ListMcpResources", "ReadMcpResource",
];

export const CLAUDE_BIN = "/root/.local/bin/claude";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AssistantEffort = (typeof EFFORT_LEVELS)[number];
export const DEFAULT_EFFORT: AssistantEffort = "high";

/** Setting TELEGRAM_ASSISTANT_EFFORT, so this is tuned without a deploy. */
export function effortFromEnv(env = process.env): AssistantEffort {
  const want = String(env.TELEGRAM_ASSISTANT_EFFORT ?? "").trim().toLowerCase();
  return (EFFORT_LEVELS as readonly string[]).includes(want) ? (want as AssistantEffort) : DEFAULT_EFFORT;
}

export interface ClaudeCliOptions {
  bin?: string;
  model?: string;
  timeoutMs?: number;
  /** How hard it thinks before replying. Higher is better and slower; set in Settings. */
  effort?: AssistantEffort;
  /** Where the CLI runs. A directory with nothing in it keeps project files out of its context. */
  cwd?: string;
}

export interface ClaudeCli {
  ask(system: string, prompt: string): Promise<string>;
}

/** True when this server can answer from the subscription rather than an API key. */
export function subscriptionAvailable(bin = CLAUDE_BIN): boolean {
  return existsSync(bin);
}

export function claudeCli(opts: ClaudeCliOptions = {}): ClaudeCli {
  const bin = opts.bin ?? CLAUDE_BIN;
  const model = opts.model ?? "opus";
  const timeout = opts.timeoutMs ?? 120_000;
  const cwd = opts.cwd ?? "/tmp";
  const effort = opts.effort ?? effortFromEnv();
  return {
    ask(system, prompt) {
      return new Promise((resolve, reject) => {
        const args = [
          "-p", prompt,
          "--model", model,
          "--append-system-prompt", system,
          "--effort", effort,
          "--disallowedTools", ...DENIED_TOOLS,
          "--output-format", "json",
        ];
        const env = { ...process.env };
        delete env.ANTHROPIC_API_KEY; // subscription auth only: never bill per token by accident
        execFile(bin, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024, env }, (err, stdout, stderr) => {
          if (err && !stdout) return reject(new Error(`claude cli: ${err.message.slice(0, 200)}${stderr ? ` — ${stderr.slice(0, 200)}` : ""}`));
          try {
            const body = JSON.parse(stdout) as { result?: string; is_error?: boolean; subtype?: string };
            if (body.is_error) return reject(new Error(`claude cli: ${body.subtype ?? "error"}`));
            resolve((body.result ?? "").trim());
          } catch {
            // Plain text output (or a partial line) is still an answer.
            resolve(stdout.trim());
          }
        });
      });
    },
  };
}
