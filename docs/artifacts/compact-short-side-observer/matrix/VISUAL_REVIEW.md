# Short-side matrix visual review

Source: `d57b7d627369e6abf2396d8a7eba7c283029df5c`

Every PNG was opened at original detail after the strict sequential matrix
completed. All four sheet margins were visible and no polygon was truncated.

| Fixture | Sheet | Review |
| --- | --- | --- |
| Triangle-20 | `2000x2700` | pass; one exact contiguous strip spans 88.288% of the short edge |
| Mixed-61 | `2000x2700` | pass; four compact rows span 99.389% of the short edge |
| Shapes-17 | `2000x2700` | pass; exact pair-fold strip spans 94.859% of the short edge |
| Triangle-20 | `600x400` | pass; guarded archive winner spans 98.731% of the short edge |
| Mixed-61 | `600x400` | pass; Compact capacity result already spans 99.825% of the short edge |
| Shapes-17 | `600x400` | pass; Compact capacity result already spans 98.021% of the short edge |
| Triangle-20 | `300x300` | pass; square Compact result spans 98.913% of either eligible edge |
| Mixed-61 | `300x300` | pass; square Compact result spans 99.837% of either eligible edge |
| Shapes-17 | `300x300` | pass; square Compact result spans 99.858% of either eligible edge |

The five Compact reuses are explicitly reported as
`short-side-satisfied-by-compact`; they are not counted as observer-generated
directional winners. The matrix contains zero `directional-miss` outcomes.
