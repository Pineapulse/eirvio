# Testing and learning environments

The labs run from a repository checkout with development dependencies. They exercise the actual EIRVIO adapters against fresh synthetic websites, real Babylon NullEngine scenes, and internal action-boundary fixtures. No external model, analytics service, customer session or account is required.

```sh
npm ci
npm run lab:test
npm run lab:learn
npm run lab:serve
```

Open the [testing environment](http://127.0.0.1:8811/) and the [learning environment](http://127.0.0.1:8812/). Keep the [interactive browser demo](http://127.0.0.1:8810/) running separately with `npm start` when testing rendering and real browser input.

## Testing environment

`npm run lab:test` runs one round of every scenario against the current source. The scenarios cover ordinary interaction, user changes during an agent plan, replacement targets, dropped acknowledgements, private content, unsupported surfaces, native form validation, animated scene objects, ownership conflicts, disposal, uncertainty, and internal admission/history boundaries.

Every scenario has explicit assertions. A correctly rejected stale command is a passing test. A thrown assertion produces a failed attempt, a nonzero command exit and retained diagnostic evidence. Each scenario disposes its DOM/scene/adapter in a `finally` block.

`npm run check` includes these scenarios alongside the unit, integration, declaration and clean-package checks. GitHub CI runs them on pushes and pull requests. The local servers run scenarios on demand; they do not schedule background work indefinitely.

## Learning environment

`npm run lab:learn` runs three seeded rounds of the same curriculum twice: first against the published v0.3.0 source, then against the current candidate. The baseline is pinned to commit `1bfad18b9b3af3671c6933e6eba143c146797b22` and the local Git tag must match. The baseline modules are extracted to a temporary directory and removed afterward. The command does not change the checkout or fetch remote code. A clone without that tag must fetch it explicitly before running this comparison.

The comparison distinguishes:

- **Improvements:** a failing baseline scenario passes every candidate attempt.
- **Regressions:** any previously passing seed fails in the candidate, even if another seed was already failing. Reports preserve the affected seeds.
- **Unresolved cases:** at least one identical seed still fails in both versions. A scenario can have both unresolved and newly regressed seeds.
- **Stable cases:** both versions pass all attempts.

Baseline failures are expected when a scenario reproduces a fixed defect. The command fails when the candidate fails; it never converts an expected baseline failure into a claimed candidate failure. Comparisons require the same scenario IDs, case versions, attempt counts and seeds.

This is an engineering feedback loop: reproduce a failure, fix the engine, retain the case, and compare results. It is not model training or an engine that changes its own source. Scenario policies are deterministic; results do not establish how an arbitrary live language model will behave.

## Reproduce and inspect a run

```sh
npm run lab:test -- 42
npm run lab:learn -- 42
```

Use the report's top-level `config.seed` to replay the run. Each scenario and round derives its own deterministic seed from that root seed. Request and adapter IDs remain fresh for every lifetime. The report records case versions, per-attempt seeds, bounded evidence, failure messages, source commit, whether the candidate had local changes, and hashes of the four adapter/kernel source modules.

Reports are stored under `reports/lab/testing/` and `reports/lab/learning/`; `latest.json` identifies the most recently completed run. The web pages show the last ten reports and provide JSON downloads. Reports stay local and are ignored by Git. Retain a source commit as well as the report to reproduce an earlier candidate; a dirty working tree hash identifies its bytes but does not save that source for you.

The two local servers share a single-run queue. Each button launches an isolated child process with a 60-second watchdog. A timeout or crashed worker is shown as an error, never a passing result. Their run endpoints accept only a bounded numeric seed from the matching local origin. There is no arbitrary command, URL or Git revision execution endpoint.

## Coverage limits

jsdom scenarios verify DOM behavior, not layout, browser occlusion or rendering. NullEngine scenarios verify real Babylon APIs without a GPU. Synthetic pointer fixtures are not proof of a real human action. Keep browser verification in the interactive demo as a separate release step. The adapters' documented shadow-tree, frame, custom-widget and gameplay-rule limits still apply.

See the [learning log](learning-log.md) for defects discovered by this first cycle and their retained regression cases.
