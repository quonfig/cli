#!/usr/bin/env node
/**
 * Standalone workspace validator.
 *
 * Usage:
 *   qfg-verify <workspace-dir>      Validate a workspace directory on disk
 *   qfg-verify --git-hook           Run as git pre-receive hook (reads stdin for refs,
 *                                   uses git commands to read files from the pushed commit)
 *
 * Exit codes:
 *   0  All checks pass
 *   1  Validation errors found
 */

import { execSync } from "node:child_process";
import * as readline from "node:readline";
import { formatResult, validateFileMap, validateWorkspace } from "./validate.js";

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--git-hook")) {
    await runGitHook();
  } else if (args.includes("--help") || args.includes("-h")) {
    printUsage();
  } else {
    const dir = args[0] || ".";
    runDiskValidation(dir);
  }
}

function printUsage() {
  console.log(`qfg-verify - Quonfig workspace validator

Usage:
  qfg-verify [path]           Validate workspace directory (default: .)
  qfg-verify --git-hook       Run as git pre-receive hook
  qfg-verify --help           Show this help

Exit codes:
  0  All checks pass
  1  Validation errors found`);
}

function runDiskValidation(dir: string) {
  const result = validateWorkspace(dir);
  console.log(formatResult(result));
  process.exit(result.valid ? 0 : 1);
}

/**
 * Git pre-receive hook mode.
 *
 * Reads stdin for pushed refs (one line per ref: <old-oid> <new-oid> <ref-name>).
 * For each new commit, lists all config files and validates them.
 */
async function runGitHook() {
  const refs: Array<{ oldOid: string; newOid: string; refName: string }> = [];

  // Read all of stdin (ref lines). Use callback API for bun compatibility.
  await new Promise<void>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line: string) => {
      const parts = line.trim().split(" ");
      if (parts.length >= 3) {
        refs.push({ oldOid: parts[0], newOid: parts[1], refName: parts[2] });
      }
    });
    rl.on("close", resolve);
  });

  if (refs.length === 0) {
    console.log("qfg-verify: no refs received");
    process.exit(0);
  }

  // Validate the latest pushed commit for each ref
  let hasErrors = false;

  for (const ref of refs) {
    // Skip deletions
    if (ref.newOid === "0000000000000000000000000000000000000000") continue;

    console.log(`qfg-verify: validating ${ref.refName} (${ref.newOid.slice(0, 8)})`);

    try {
      const files = readFilesFromCommit(ref.newOid);
      const result = validateFileMap(files);
      console.log(formatResult(result));

      if (!result.valid) {
        hasErrors = true;
      }
    } catch (err: unknown) {
      console.error(`qfg-verify: error reading commit ${ref.newOid}: ${(err as Error).message}`);
      hasErrors = true;
    }
  }

  process.exit(hasErrors ? 1 : 0);
}

/**
 * Read all JSON config files from a git commit using `git show`.
 * Works in bare repos (no working tree needed).
 */
function readFilesFromCommit(commitOid: string): Map<string, string> {
  const files = new Map<string, string>();
  const dirs = ["configs", "feature-flags", "segments", "log-levels", "schemas"];

  for (const dir of dirs) {
    // List files in this directory at the given commit
    let listing: string;
    try {
      listing = execSync(`git ls-tree --name-only ${commitOid} ${dir}/`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      // Directory doesn't exist in this commit
      continue;
    }

    const filenames = listing.trim().split("\n").filter(Boolean);
    for (const filePath of filenames) {
      if (!filePath.endsWith(".json") || filePath.includes("/.")) continue;

      try {
        const content = execSync(`git show ${commitOid}:${filePath}`, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        files.set(filePath, content);
      } catch {
        // File can't be read, skip
      }
    }
  }

  return files;
}

main().catch((err) => {
  console.error(`qfg-verify: fatal: ${err.message}`);
  process.exit(1);
});
