---
name: gpt-image-2
description: Generate concept images, product UI mocks, dashboards, landing-page comps, storyboard frames, and polished visual directions with a GPT-Image-2 compatible image API. Use when asked to visualize a product idea, create a mockup, produce a shareable concept board, iterate on an existing image with edits, or turn a written interface concept into a static image.
compatibility: Requires OPENCODE_IMAGE_API_BASE and OPENCODE_IMAGE_API_KEY. Optional OPENCODE_IMAGE_MODEL (defaults to gpt-image-2). Uses python3 only.
---

# GPT Image 2

Project-level image generation skill for static visual concepts.

Use this skill when the user wants:

- a UI mock or concept board
- a polished product screenshot concept
- a hero image, poster, or cover art
- multiple visual directions for the same idea
- edits based on a reference image

## Environment

Use these environment variables:

- `OPENCODE_IMAGE_API_BASE`
- `OPENCODE_IMAGE_API_KEY`
- optional `OPENCODE_IMAGE_MODEL` (defaults to `gpt-image-2`)

Do not put API keys in source files.

## Output rules

- Put committed visual assets under `docs/mockups/` unless the user asks for another path.
- Put disposable or exploratory outputs under `.files/mockups/`.
- Save a sibling `*.prompt.md` file for important generated images so the prompt can be iterated later.
- Prefer PNG for UI mocks and interface boards.
- For UI mock requests, generate clean frames with no browser chrome unless explicitly requested.
- Avoid tiny unreadable placeholder text; prefer bold structural labels and clear hierarchy.

## Rate limit

Assume a conservative limit of **7 images per minute** unless the user says otherwise.

For batches, keep `--rpm 7` or lower.

## Generate one image

```bash
python3 .agents/skills/gpt-image-2/scripts/generate_gpt_image.py \
  --prompt-file docs/mockups/pi-foundry-client-ui-mock.prompt.md \
  --out docs/mockups/pi-foundry-client-ui-mock.png \
  --size 1536x1024 \
  --format png
```

Or inline:

```bash
python3 .agents/skills/gpt-image-2/scripts/generate_gpt_image.py \
  --prompt 'A polished SaaS control-plane dashboard UI concept...' \
  --out .files/mockups/dashboard-concept.png \
  --size 1536x1024 \
  --format png
```

## Reference-image edits

```bash
python3 .agents/skills/gpt-image-2/scripts/generate_gpt_image.py \
  --prompt 'Keep the same layout, but make the visual style more premium and enterprise.' \
  --reference docs/mockups/pi-foundry-client-ui-mock.png \
  --out docs/mockups/pi-foundry-client-ui-mock-v2.png \
  --size 1536x1024 \
  --format png
```

This uses the OpenAI-compatible `/images/edits` endpoint with `input_fidelity=high`.

## Best-practice prompt pattern for UI mocks

Use prompts with this structure:

1. **Product + audience** — what product is this for, and who uses it?
2. **Primary workflow** — what is the user trying to do?
3. **Information architecture** — what panels, cards, nav, or screens must appear?
4. **Visual system** — color mood, density, typography feel, icon style.
5. **Shot framing** — single screen, multi-screen board, desktop-only, device mix, etc.
6. **Constraints** — no lorem spam, readable hierarchy, no watermark, no logo clutter.

Suggested skeleton:

```text
Create a high-fidelity UI concept board for [product].
Audience: [user type].
Primary workflows: [workflow list].
Show these screens: [screen list].
Visual style: [style].
Layout: [board / single screen / desktop / mobile].
Constraints: minimal noise, readable labels, strong hierarchy, no watermark, no stock-photo collage.
```

## Capture metadata beside important images

For serious design iterations, keep these files together:

- `mock-name.png`
- `mock-name.prompt.md`
- optional `mock-name.notes.md`

## Review checklist

Before presenting a generated UI mock, check:

- Does it reflect the actual product architecture?
- Are the primary user flows visible?
- Is the hierarchy readable at a glance?
- Does it separate end-user surfaces from developer surfaces when needed?
- Does it feel like a tool people could actually use, not generic sci-fi UI?
