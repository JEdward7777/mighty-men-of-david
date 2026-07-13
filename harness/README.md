# Harness

A working folder for tracking the state of the **Mighty Men of David** codebase:
problems found, decisions made, and the progress of larger changes.

This project was originally scaffolded by a less-capable model, so the code has a
number of latent bugs and one fundamental architectural problem (peer-to-peer
WebRTC that does not work across networks). This folder is where we keep score.

## Contents

| File | Purpose |
|------|---------|
| [`ISSUES.md`](./ISSUES.md) | Catalogue of problems found in the code, ranked by severity |
| [`DURABLE-OBJECTS-MIGRATION.md`](./DURABLE-OBJECTS-MIGRATION.md) | Plan + progress for replacing WebRTC P2P with a Durable Object |

## How to use

- When you find a new problem, add a row to `ISSUES.md` with a severity and a
  short repro/impact note.
- When you fix something, mark it resolved (don't delete it — the history is
  useful) and reference the commit.
- Keep the migration doc updated as the source of truth for the DO rewrite.
