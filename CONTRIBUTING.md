# Contributing

Use Node.js 22 or newer. Run `npm ci`, then `npm run check`. The check runs core and SDK tests, a strict TypeScript consumer, the terminal example, a localhost transport test, an npm package inventory check and a clean tarball consumer outside the repository.

Keep `eirvio` browser-safe and independent of `eirvio/host` and `eirvio/core`. Put host permissions in trusted application code. Preserve stable command identity, stale-state rejection and uncertain-delivery semantics. Do not infer authority or successful mutation from event tracking.

Use small domain-neutral tests and synthetic data. Add meaningful regression tests for behavior changes. Keep the public action catalog, domain validators, documentation and declarations consistent. New runtime dependencies, transport protocols, model-provider integrations and persistence adapters need an explicit design and validation.

Open an issue or pull request with the problem, resulting behavior and validation. Never include credentials, personal data, replay snapshots from real users or production tokens. Contributions are licensed under MIT.
