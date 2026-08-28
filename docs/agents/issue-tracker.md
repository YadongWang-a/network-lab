# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `.wayfinder/` (the wayfinder map + tickets). This repo has **no git remote** (it is a downloaded snapshot, not a GitHub/GitLab checkout), so a local-markdown tracker is used instead of hosted Issues.

## Conventions

- **Map**: `.wayfinder/MAP.md` — the Destination / Notes / Decisions-so-far / Not-yet-specified / Out-of-scope body.
- **Tickets**: one file per ticket at `.wayfinder/tickets/WF-<NN>.md`, numbered from `01`.
- **Type**: frontmatter `type` (`research` / `prototype` / `grilling` / `task`).
- **Blocking**: frontmatter `blocked_by: [WF-X, WF-Y]`. A ticket is unblocked when every ticket it lists is `closed`.
- **Status**: frontmatter `status` (`open` / `closed`).
- **Claim**: frontmatter `assignee` (empty string `""` = unclaimed).
- **Resolution**: append the answer under a `## Resolution` heading, set `status: closed`, then append a context pointer (gist + link) to the map's Decisions-so-far in `MAP.md`.

## When a skill says "publish to the issue tracker"

Create a new file under `.wayfinder/tickets/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the ticket id directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single file with one child file per ticket.

- **Map**: `.wayfinder/MAP.md`
- **Child ticket**: `.wayfinder/tickets/WF-<NN>.md`, with the question in the body.
- **Blocking**: a `blocked_by:` frontmatter list. A ticket is unblocked when every ticket it lists is `closed`.
- **Frontier**: scan `.wayfinder/tickets/` for files that are open, unblocked, and unassigned (`assignee: ""`); first by number wins.
- **Claim**: set `assignee:` to the dev and save before any work.
- **Resolve**: append the answer under `## Resolution`, set `status: closed`, then append a context pointer (gist + link) to the map's Decisions-so-far in `MAP.md`.

> Note: the skill's default local convention is `.scratch/<feature>/`. This repo instead uses `.wayfinder/` because the wayfinder map already lives there; the operations are identical, only the root path differs.
