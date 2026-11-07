# Security

EIRVIO 0.3.0 is an early, in-memory runtime and SDK. It is not an authentication service or a hardened multi-tenant backend. Applications own verified identity, authorization policy, transport isolation, rate limits, storage retention and appropriate data handling.

Treat agent output, UI events, event actor labels and transported JSON as untrusted input. Only trusted host code supplies permission contexts. Domain reducers and projectors are trusted synchronous code, not a sandbox. Never accept arbitrary reducer code, expose `admin: true`, publish private replay artifacts, or convert a tracked event directly into permission to act.

The example HTTP server listens only on loopback and checks Host, Origin, method and request size. It is a disposable single-process demonstration with no user authentication. Do not expose it as a public service.

Report a suspected vulnerability through the repository's private vulnerability reporting feature when available, or privately to the maintainer listed on the GitHub profile. Do not open a public issue containing exploit details, secrets or user data. There is no promised response SLA at this early stage.

The automatic web adapter reads public semantic DOM text and ordinary form values. Mark private subtrees with `data-eirvio-private`; password, file, hidden and recognized credential/payment fields are excluded. Visible interface content is data, not trusted agent instructions. Local DOM/Babylon actions use the page’s existing authority and are not authenticated server transactions. The integrating agent owns its action policy and any authenticated remote tool connection. The SDK opens no remote connection and collects no analytics.
