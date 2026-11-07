# Contributing

Use Node.js 22 or newer. Run `npm ci`, then `npm run check`. The check runs core and SDK tests, a strict TypeScript consumer, the terminal example, a localhost transport test, an npm package inventory check and a clean tarball consumer outside the repository.

Keep `eirvio` browser-safe and independent of `eirvio/host` and `eirvio/core`. Put host permissions in trusted application code. Preserve stable command identity, stale-state rejection and uncertain-delivery semantics. Do not infer authority or successful mutation from event tracking.

Use small domain-neutral tests and synthetic data. Add meaningful regression tests for behavior changes. Keep the public action catalog, domain validators, documentation and declarations consistent. New runtime dependencies, transport protocols, model-provider integrations and persistence adapters need an explicit design and validation.

Open an issue or pull request with the problem, resulting behavior and validation. Never include credentials, personal data, replay snapshots from real users or production tokens. Contributions are licensed under MIT.

Automatic adapters have separate DOM (jsdom) and real Babylon NullEngine tests. The primary TypeScript consumer checks all EIRVIO declarations strictly. A second consumer checks assignability from a real Babylon Scene with third-party declaration checks skipped: Babylon 8.26 declares WebGPU globals that overlap with TypeScript 7’s DOM library. This does not weaken the primary SDK declaration check.

For an engine behavior change, add a versioned scenario in `lab/scenarios/` when it contributes meaningful multi-step coverage. Use the injected adapter/kernel, public tool calls for interface scenarios, synthetic inputs, bounded evidence, and unconditional cleanup. `npm run lab:learn -- 42` compares the exact same curriculum with the pinned release baseline. Increment a case version when its assertions or meaning change. See [testing environments](docs/testing.md).
