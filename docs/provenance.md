# Provenance and naming

The generic core was extracted from the author's chess-workshop project at source commit `4adc740`. This repository starts fresh Git history and includes only the standalone kernel, protocol, tests, SDK and synthetic examples. It does not include the chess application, learner checkpoints, local data, generated artwork or earlier private repository history. The kernel source retains its original 0.1.0 protocol semantics.

The SDK and task-board example were developed for this standalone release. All runtime code is first-party and distributed under MIT. There are no runtime dependencies. TypeScript is a pinned development dependency with its own upstream license, and GitHub Actions dependencies are pinned separately in the workflow.

EIRVIO expands to **Event-Instrumented Runtime for Verified Interface Operations**. The intended pronunciation is “AIR-vee-oh.” “Verified” describes schema validation, authorization and revision checks, not formal verification.

On November 7, 2026, preliminary searches found zero exact-name GitHub repository matches for EIRVIO and no package at the exact unscoped npm name. These checks do not reserve a name or establish trademark clearance. Alternative candidates considered were IVRELO and AVRELIO, both of which had unrelated public uses.

The event-name/properties ergonomics are inspired by public product analytics APIs. No Mixpanel or Amplitude SDK, proprietary code, service integration or hosted analytics is included.
