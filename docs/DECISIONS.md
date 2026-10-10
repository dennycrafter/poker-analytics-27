# Decisions

Coordination decisions for the PA27 build. Newest first.

## 2026-10-10 — Merge method switches to PR + squash after wave 1 (owner instruction)

Wave 1 of the variance/import brief (12 lanes, branches `feat/it1-*` … `feat/it-variance-ui`,
cut from `49c87ae`) finishes under the current method: orchestrator verifies each lane,
runs the full test battery, merges with git, pushes `main` immediately after every merge.

After wave 1 is fully merged, every future branch follows this method:

1. Run the same tests as now (full suite battery on the branch head).
2. Open a pull request with `gh pr create`.
3. Merge with `gh pr merge --squash --delete-branch`.
4. No `git merge` for these.
5. Never merge a branch whose tests fail, whichever method is used.

If `gh pr create` or `gh pr merge` fails (for example, no permission to create PRs),
retry once. If it fails again, fall back to `git merge` for the rest of the build,
note the failure here in `docs/DECISIONS.md`, and keep going without stopping or asking.

## 2026-10-10 — Push to GitHub regularly as crash insurance (owner instruction)

The run is fully autonomous with no hard stop. State is kept durable: lane branches are
pushed to origin by workers, `main` is pushed immediately after each merge, and
coordination docs (this file, `docs/ASSUMPTIONS.md`, `docs/BLOCKERS.md`) are committed
and pushed when created or updated. If the orchestrator session dies, a fresh session
resumes from the task tree, origin branches, and memory facts.
