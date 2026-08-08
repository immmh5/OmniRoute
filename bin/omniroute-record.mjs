#!/usr/bin/env node

/**
 * Run OmniRoute normally while recording the complete terminal stream.
 *
 * Usage:
 *   node bin/omniroute-record.mjs [normal OmniRoute args...]
 *
 * Each run gets its own timestamped file under:
 *   $DATA_DIR/logs/terminal/
 * or, when DATA_DIR is unset:
 *   ./logs/terminal/
 *
 * Both stdout and stderr are copied to the terminal and the file. Exit status and
 * signal termination are forwarded from the real OmniRoute process.
 */
import { mkdirSync, createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.DATA_DIR?.trim() || root;
const logDir = join(dataDir, "logs", "terminal");
mkdirSync(logDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const logPath = join(logDir, `omniroute-${stamp}.log`);
const log = createWriteStream(logPath, { flags: "a" });

const child = spawn(process.execPath, [join(root, "bin", "omniroute.mjs"), ...process.argv.slice(2)], {
  cwd: root,
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
});

const write = (chunk, stream) => {
  log.write(chunk);
  stream.write(chunk);
};

child.stdout.on("data", (chunk) => write(chunk, process.stdout));
child.stderr.on("data", (chunk) => write(chunk, process.stderr));

const shutdown = (signal) => {
  if (!child.killed) child.kill(signal);
};
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

child.on("error", (error) => {
  const message = `[omniroute-record] failed to start: ${error.message}\n`;
  log.write(message);
  process.stderr.write(message);
});

child.on("close", (code, signal) => {
  log.end(() => {
    process.stderr.write(`\n[omniroute-record] full log: ${logPath}\n`);
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
});
