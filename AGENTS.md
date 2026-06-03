# AGENTS.md — pi-foundry design principles

Guidance for any agent or contributor working on this repo. Keep changes aligned
with these. When a tradeoff isn't covered here, ask.

1. **Lightweight, simple, easy.**
   Surgical diffs; prefer deleting a line over adding one; defaults must work with
   zero config so users never have to tune knobs to succeed.

2. **Don't reinvent the wheel.**
   Lean on `azd` and existing platform/tooling first; build our own only where the
   platform genuinely can't reach (e.g. the runtime SSE heartbeat).

3. **User experience first.**
   Never ship a trap. The happy path should be the default path; if a limit is
   unavoidable, document it where the user will hit it.

4. **Bring Your Own Agent to Foundry.**
   The user's repo is the source of truth. Add only the standard files, never a
   private framework dir, and keep one-command opt-out intact.

5. **The Skill is the product's final interaction.**
   The best deploy/troubleshoot/long-task experience lives in the skill, not in raw
   commands. Invest there.

6. **Docs are concise and user-facing.**
   Write from the user's task perspective, not pi-foundry's development perspective.
   State the value and the action; drop the internal rationale.

## Releasing the runtime image

To release: bump `package.json` `version`, commit, push a `vX.Y.Z` tag. CI
(`.github/workflows/runtime-image.yml`) builds and publishes both harness images
`ghcr.io/<owner>/pi-foundry-runtime:{X.Y.Z, X.Y, latest}` (pi) and
`ghcr.io/<owner>/ghcp-foundry-runtime:{X.Y.Z, X.Y, latest}` (GitHub Copilot).
Never `docker push` by hand.
