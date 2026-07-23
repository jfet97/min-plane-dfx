# Canonical Reference Decode Handoff Artifacts

> Historical immutable evidence for the retired fixed-reference coordinator.
> It does not establish current archive-only production invariance.

These artifacts certify the mixed-61 sheet-invariance gate at source commit
`5186255` on branch `canonical-reference-decode-handoff`.

- `report.json` is the immutable ten-sheet corpus report.
- `manifest.json` records the source commit, clean-tree state, fixture hash,
  exact command, runtime environment, and artifact hashes.
- `mixed-61-*.svg` are the ten accepted vector renders.
- `png/mixed-61-*.png` are complete Electron/Chromium previews of those SVGs.
- all ten outputs have canonical geometry hash
  `40f8ac9c0fb24073ac141b5fb667366af55df90c78c6cca21ff76703a4a7f300`;
- every output places 61 pieces at `430344.917527 mm2`, with two holes and
  structural contacts `53/14`.

The SVG files are byte-identical (`sha256`
`2d8556fc00b7517a4b3c06a35dac1c3f755063f94f840de22b53a89b4a6f6c93`)
because the accepted collision arrangement is independent of sheet dimensions.
The PNG files are likewise byte-identical (`sha256`
`cfb4e876cafd676f835434e7f201bf3e9a7188cb69c774a261ce569bc3c66d1a`).
The report hash is
`b1e1059231312200ec9879a25697bcadd8fdd622b8d28a32eacb4750af1e0d84`.
