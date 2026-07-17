---
name: render-svg-with-electron
description: Convert a local SVG into a complete, readable PNG preview with the repository's installed Electron/Chromium renderer. Use when generated SVG layouts must be visually inspected or shared and Quick Look, editor thumbnails, or direct image viewing crop, truncate, or mis-scale the SVG.
---

# Render SVG with Electron

Use the bundled CommonJS renderer so Electron executes the script reliably and
Chromium renders the complete SVG. Do not use `qlmanage` for layout approval: its
square thumbnails can crop wide SVG content.

## Workflow

1. Run from the repository root, outside the sandbox because Electron launches
   a GUI process:

   ```sh
   pnpm exec electron \
     .agents/skills/render-svg-with-electron/scripts/render-svg.cjs \
     /absolute/input.svg \
     /absolute/output.png \
     1000
   ```

   The output path and target width are optional. Defaults are
   `<input>.png` and `1000` pixels.

2. Inspect the generated PNG with the local image-viewing tool.

3. Confirm that all four sides have visible background margin and no polygon is
   truncated before judging layout quality.

4. Report or link both the SVG and PNG when the visual result matters.

The script embeds the SVG in a marginless HTML page, uses `object-fit: contain`,
captures a fixed 4:3 viewport, and resizes the complete capture. It adds no
application dependency and does not modify the source SVG.
