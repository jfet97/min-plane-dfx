# V7 Search Redesign Evidence

Portable evidence for `reviews/v7-search-redesign-review.md`, produced on the
review machine (darwin arm64, node v24.11.1) from committed harnesses on
branch `v7-search-redesign-review`. Raw immutable reports live under
`/private/tmp/min-plane-provenance/v7-search-redesign-*`; `summary.json` here
records each cited run's report path, its SHA-256, and its compact metrics.

Fixture and command provenance: every run used
`scripts/irregular-intrinsic-periodic-family-portfolio.ts` or
`scripts/irregular-sheet-invariance.ts` with the exact flags recorded in the
review's "Reproduction Commands" section and inside each raw report's
`limits` block.

| Artifact | Status | What it is |
| --- | --- | --- |
| `triangle-20-witness-74428-371db269.svg/.png` | diagnostic | The reproduced 74,428.143126 mm² two-band raw-crop Pareto witness (hash `371db269…`), source commit `6bcba8c`. Not reachable by the default portfolio (its basis retains zero cells in the bounded front); exists via `--source-survival-audit`. |
| `triangle-20-witness-90352-4b87d6df.svg/.png` | accepted (archive content) | The 90,352.625 mm², max side 394.922, 7-isolate / 9-component three-band lattice that wins the Triangle archive once `--admit-raw-witnesses` lets raw Pareto witnesses compete (source commit `96368ca`, replay hash-identical). Not a golden; misses the production golden gates. |
| `mixed-61-periodic-420059-a79f6148.svg/.png` | accepted (archive content) | New best periodic Mixed endpoint from this machine's default run at `6bcba8c`: 420,059.254 mm², 0 cavities, 33/10 contacts, 23 isolates. Exists because this machine completed 4/8 continuations inside the same 25 s wall deadlines (coverage is machine-relative — see review finding F6). |
| `mixed-61-production-invariant-f58cf0f2-2000x2700.svg/.png` | diagnostic | The production-path sheet-invariant Mixed layout (61/61, 435,949.517 mm², 0 cavities, hash `f58cf0f2…` on 660–2700-wide sheets; diverges only below the 654.13 mm fit boundary). Quality is visibly below the 405,773 reference; the artifact documents invariance, not quality. |
| `summary.json` | index | Compact metrics + SHA-256 for all twelve cited runs, including the eight-arm pressure matrix (all arms: zero canonical-exact endpoints) and the restart-ablation reproduction (loss values byte-equal to the author machine). |

SHA-256:

```text
172a45509fd36257514bb87f500f26a09bd9a9ce5c72976c0d4d916ae8c8975f  triangle-20-witness-74428-371db269.svg
0d2ba7f5a70e2e9d966e57dbed54a432baf18c99e3f95628adb7daf1d97e170a  triangle-20-witness-74428-371db269.png
2a259ce684157ee7c082320f208cd3454c4cdf4a70e985c2977ce9f29f1a6a64  triangle-20-witness-90352-4b87d6df.svg
d428e1b9cad776c09d53f71d90d8e710f115704267b6bafc293786b3cbcb0fab  triangle-20-witness-90352-4b87d6df.png
4f2ecfbcc560d27e9913c91dd3eb3a4e8cb69de712106571688b2b46ffbec488  mixed-61-periodic-420059-a79f6148.svg
3fbf1d0a74a6333ca98b0c39fa248f394b9e157a945b69b30dadb41ccaca34d8  mixed-61-periodic-420059-a79f6148.png
3c4702c0271301d47f0bd69c9863a5f736406c380ea4a5529879afb868d0122b  mixed-61-production-invariant-f58cf0f2-2000x2700.svg
e47c4eb47dfc446a831ff6143d1efb89f6489b9a04ed5446bfa5f0ac9d00a536  mixed-61-production-invariant-f58cf0f2-2000x2700.png
878f5951aad15895b84123aee5cee0cb314f1b664d8d44bbce0f6314c79d95e2  summary.json
```

Rejected/diagnostic runs are indexed in `summary.json` with the same
discipline; no rejected mechanism was left enabled by default (the sampled
relocation vocabulary and raw-witness admission are explicit opt-in flags).
