import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { resolve, relative } from "node:path";
import { existsSync } from "node:fs";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "backup",
    label: "Backup",
    description: "Save a fsnap snapshot of a file before making changes. Call this BEFORE edit/write when you're about to modify an important file.",
    promptSnippet: "Create a fsnap snapshot backup with a human-readable description of what you're about to change.",
    promptGuidelines: [
      "Before editing an existing file, consider calling backup() with a clear description of the change you're about to make (e.g. 'add type annotations to add/subtract', 'refactor main() into helper functions').",
      "Only call backup() for meaningful changes. Skip trivial edits like fixing typos or minor formatting.",
      "The description you provide will appear in `fsnap l` output, so make it descriptive enough to identify the snapshot later.",
    ],

    parameters: Type.Object({
      description: Type.String({
        description: "Human-readable description of what you're about to change. E.g. 'refactor add() to use type hints' or 'extract validation logic into helper'.",
      }),
      path: Type.String({
        description: "Path to the file to back up (relative to cwd, or absolute).",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const absolutePath = resolve(ctx.cwd, params.path);

      if (!existsSync(absolutePath)) {
        return {
          content: [{ type: "text", text: `File not found: ${params.path}` }],
          details: {},
          isError: true,
        };
      }

      const result = await pi.exec("fsnap", ["s", params.description, absolutePath]);
      const match = result.stdout?.match(/Snapshot saved: (\S+)/);
      const snapId = match ? match[1] : "?";

      ctx.ui.notify(`fsnap backup: ${params.description} (${snapId})`, "info");

      return {
        content: [{
          type: "text",
          text: `Snapshot saved: ${snapId}\nDescription: ${params.description}\nFile: ${params.path}`,
        }],
        details: { snapshotId: snapId, description: params.description, path: params.path },
      };
    },
  });

  // ──────────────────────────────────────────────
  // restore tool: two-step flow
  //   1st call: search snapshots, return candidates for LLM to match
  //   2nd call: with snapshotId, confirm with user and restore
  // ──────────────────────────────────────────────

  interface Snap {
    id: string;
    file: string;
    description: string;
  }

  function parseSnapshots(stdout: string): Snap[] {
    return stdout
      .split("\n")
      .filter((l) => l.includes(" | "))
      .map((line) => {
        const parts = line.trim().split(" | ");
        if (parts.length < 3) return null;
        return { id: parts[0].trim(), file: parts[1].trim(), description: parts.slice(2).join(" | ").trim() };
      })
      .filter((s): s is Snap => s !== null);
  }

  pi.registerTool({
    name: "restore",
    label: "Restore Snapshot",
    description:
      "Find and restore a previous fsnap snapshot. " +
      "Use this when the user wants to revert a file to a previous state. " +
      "Two-step flow: (1) call without snapshotId to search; " +
      "(2) call with snapshotId (matched from results) to confirm and restore.",
    promptSnippet:
      "Find and restore a previous snapshot. First call searches (omit snapshotId); second call restores (pass snapshotId from results).",
    promptGuidelines: [
      'When the user says something like "restore the quicksort version" or "go back to the mergesort version", call this tool.',
      "Step 1 — search: omit snapshotId, pass description (and optionally file). The tool returns matching snapshots with IDs and descriptions.",
      "Step 2 — restore: pass the exact snapshotId you identified from step 1. The tool will ask the user to confirm before restoring.",
      "Always do step 1 first. Never guess a snapshotId without searching.",
    ],

    parameters: Type.Object({
      description: Type.String({
        description:
          "What the user wants to restore, in natural language. E.g. 'the quicksort version of a.py' or 'before the refactoring'.",
      }),
      snapshotId: Type.Optional(
        Type.String({
          description:
            "Exact snapshot ID to restore. Omit this on the first call (search). " +
            "On the second call, pass the ID from the search results.",
        }),
      ),
      file: Type.Optional(
        Type.String({
          description: "Optional file path to narrow the search (relative to cwd, or absolute).",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [
            { type: "text", text: "Interactive UI is required for confirmation. Cannot restore in non-interactive mode." },
          ],
          details: {},
          isError: true,
        };
      }

      // ── Step 2: snapshotId provided → confirm & restore ──
      if (params.snapshotId) {
        // Get snapshot details from fsnap v
        const info = await pi.exec("fsnap", ["v", params.snapshotId]);
        if (info.code !== 0) {
          return {
            content: [{ type: "text", text: `Snapshot not found: ${params.snapshotId}` }],
            details: {},
            isError: true,
          };
        }

        const relFile = params.file ? relative(ctx.cwd, resolve(ctx.cwd, params.file)) : "(unknown)";
        const confirmed = await ctx.ui.confirm(
          "Restore snapshot?",
          `Snapshot: ${params.snapshotId}\nDescription: ${params.description}\n\nThis will overwrite the current file. Continue?`,
        );

        if (!confirmed) {
          ctx.ui.notify("Restore cancelled", "info");
          return { content: [{ type: "text", text: "Restore cancelled by user." }], details: {} };
        }

        const restoreResult = await pi.exec("fsnap", ["r", params.snapshotId]);
        const isError = restoreResult.code !== 0;

        ctx.ui.notify(
          isError ? `Restore failed: ${restoreResult.stderr}` : `Restored: ${params.snapshotId}`,
          isError ? "error" : "success",
        );

        return {
          content: [
            {
              type: "text",
              text: isError
                ? `Restore failed:\n${restoreResult.stderr}`
                : `Restored snapshot ${params.snapshotId}\nDescription: ${params.description}`,
            },
          ],
          details: { snapshotId: params.snapshotId, description: params.description },
          isError,
        };
      }

      // ── Step 1: search ──
      const result = await pi.exec("fsnap", ["l"]);
      const all = parseSnapshots(result.stdout ?? "");

      if (all.length === 0) {
        return { content: [{ type: "text", text: "No snapshots found." }], details: {} };
      }

      // Filter by file path if provided
      let candidates = all;
      if (params.file) {
        const abs = resolve(ctx.cwd, params.file);
        candidates = all.filter((s) => s.file === abs || s.file.endsWith(params.file!));
        if (candidates.length === 0) {
          return {
            content: [{ type: "text", text: `No snapshots found for file: ${params.file}` }],
            details: {},
          };
        }
      }

      // Return candidates for LLM to semantically match
      const lines = candidates.map(
        (s) => `${s.id.padEnd(20)} ${relative(ctx.cwd, s.file).padEnd(48)} ${s.description}`,
      );

      return {
        content: [
          {
            type: "text",
            text:
              `Found ${candidates.length} snapshot(s). ` +
              `The user wants: "${params.description}".\n\n` +
              `Review the list below, identify the matching snapshot ID, ` +
              `then call restore again with the correct snapshotId.\n\n` +
              lines.join("\n"),
          },
        ],
        details: { candidates: candidates.map((s) => ({ id: s.id, file: s.file, description: s.description })) },
      };
    },
  });
}
