# Focused Complete Reconstruction Boundary

This artifact set proves that the focused complete reconstruction starts from
the settled sheetless leader rather than from whichever lower-ranked complete
endpoint happens to fit the requested sheet.

On Shapes-17 at `540 x 580`, the protected sheetless leader
`c640c06f...` does not fit. With focused reconstruction enabled, that exact
leader is rebuilt into `1ddc8426...`, which fits and is selected. With the
explicit disable control, the lower-ranked fitting protected endpoint
`104f99ee...` remains selected.

| Mode | Placed | Canonical hash | Area | Maximum side | Runtime | PNG |
| --- | ---: | --- | ---: | ---: | ---: | --- |
| focused default | 17/17 | `1ddc8426...` | `281,233.148068 mm2` | `532.691 mm` | `12.432 s` | [`shapes-17-540x580.png`](./shapes-17-540x580.png) |
| disabled control | 17/17 | `104f99ee...` | `310,542.212676 mm2` | `578.418 mm` | `10.542 s` | [`shapes-17-540x580-disabled.png`](./shapes-17-540x580-disabled.png) |

Both reports were generated from source commit
`acb418629cf4f494f5322829cc04cc9f859b3a4a` with Node `v24.16.0` on macOS
arm64. The enabled trace records `8,035` complete-reconstruction candidate
evaluations in `1.728 s`, complete accounting, and the distinct source,
candidate, and final-selected hashes.

The PNGs are full Chromium renders of the exact report SVGs. File hashes are in
[`manifest.json`](./manifest.json).
