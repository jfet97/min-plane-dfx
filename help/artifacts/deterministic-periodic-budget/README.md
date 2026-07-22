# Deterministic periodic continuation budget

Source branch: `deterministic-periodic-budget`

Implementation commits:

- `ee9d0fab15198f0ce765b85b1aa05f74acebcc5b` adds exact candidate-evaluation caps.
- `163fac1` schedules explicitly capped continuations by compact intrinsic seed geometry.

The source-pinned Mixed-61 continuation reproduces canonical hash
`310adc648970ae24798241bbb7178bbbc6f4506b1506012392235470a6dc6d0a`
at exactly 19,862 direct-legal candidate evaluations. A cap of 19,861 reports
`evaluation-cap` and produces no endpoint.

The full eight-source run at cap 19,862 executes the two smallest square-basis
crops first. The second crop completes with the same hash at 426,530.392211
mm2, zero enclosed cavities, and 30/10 total/dominant contacts. The old source
order reached this crop seventh and timed out before producing it.

The full run remains execution-incomplete: five later sources reach the
evaluation cap or wall-time safety limit, and two never start. The eight-source
report spends 300,019 ms in total, of which 118,898 ms are attributed to
continuation runs and 181,121 ms remain in catalog/selection and uninstrumented
overhead. This makes phase-level timing and selection-cost reduction the next
measurement; it does not justify claiming complete portfolio coverage.

Raw immutable evidence:

- `/private/tmp/min-plane-provenance/deterministic-periodic-ee9d0fa/mixed-source-exact-cap/report.json`
- `/private/tmp/min-plane-provenance/deterministic-periodic-ee9d0fa/mixed-source-cap-minus-one/report.json`
- `/private/tmp/min-plane-provenance/deterministic-periodic-ee9d0fa/mixed-full-eight-cap-19862/report.json`
- `/private/tmp/min-plane-provenance/deterministic-periodic-163fac1/mixed-full-eight-area-first-cap-19862/report.json`

The compact machine-readable result is in `summary.json`.
