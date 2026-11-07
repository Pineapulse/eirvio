# SDK API 0.1.0

## Events

`createEventStream({catalog, maxEvents=1000, maxPropertyBytes=16384, maxDepth=8, maxListeners=100, clock=Date.now, onListenerError?})` creates a local stream. No network request or browser storage is used. The catalog maps event names to closed object schemas. Supported schema fields are documented by `EventDefinition` and `PropertySchema` in the TypeScript declarations; this is a bounded subset, not a general JSON Schema implementation. Nested objects are also closed. Unknown names or properties reject.

`track(name, properties={}, context={})` synchronously appends and delivers a detached event. Context permits `actor: 'user'|'agent'|'system'`, `traceId` and `correlationId`. Default actor is `user`. These labels are caller assertions and confer no authority. Plain JSON only; accessors, prototypes, cycles, unsupported values and excessive depth/bytes reject. Applications still decide which declared data is appropriate to share with an agent.

`subscribe(listener)` returns an unsubscribe function. Synchronous throws and asynchronous rejections are isolated from other listeners. Reentrant synchronous `track` calls from a subscriber reject with `EVENT_REENTRANCY`; schedule deliberate subsequent work outside that delivery rather than creating feedback loops. Promise-returning listeners are not awaited.

`history({after=0, limit=maxEvents})` returns `{events, cursor, oldestCursor, gap, hasMore}`. `cursor` is the stream head. While paginating, resume from the **last returned event's cursor**, not the head, or you will skip remaining events. If `gap` is true, older events have been evicted; obtain fresh state rather than treating history as a complete log. The stream is in memory, with no exactly-once consumer guarantee or persistence.

Explicitly merge `SDK_EVENT_CATALOG` into your event catalog, and pass the stream as the client's `events` option, to record `interaction.submitted`, `interaction.outcome` and `interaction.uncertain`. These contain command/control kind, operation, stable operation ID and optional outcome status. They exclude arguments, state projections and result payloads. Lifecycle actor is `system`; correlation ID is the operation ID. Diagnostics failures never change submission results.

The name/properties API is inspired by the documented [Mixpanel JavaScript track API](https://docs.mixpanel.com/docs/tracking-methods/sdks/javascript) and [Amplitude track API](https://amplitude.com/docs/sdks/analytics/browser/browser-sdk-2/get-started). Neither vendor is a dependency or destination.

## Client

`createInteractionClient({transport, events?})` captures these transport methods:

| Method | Request | Response |
| --- | --- | --- |
| `observe()` | No arguments | Native projected observation with exact guards and permitted operations |
| `catalog()` | No arguments | Array of `{name, description, parameters}` action descriptors |
| `submit(command)` | Prepared native command | Matching native outcome |
| `getOutcome(operationId)` | Stable operation ID | Matching native outcome or a definite lookup error |
| `control(control)` | Optional scoped control transport method | Matching native outcome |

Transport methods may be synchronous or return promises. The client API is asynchronous. No HTTP routes, credentials or default endpoints are embedded. The [local demo transport](../examples/task-board/app.mjs) uses a same-origin RPC endpoint; it is an example, not an authenticated production gateway.

`prepare(name, properties, {observation, commandId})` returns an immutable, detached native command. It copies the exact scene revision, runtime fence, scope and optional view from the supplied observation. Preparation checks the observed capability; the host checks current authority again when submitting. `act(name, properties, options)` combines preparation and submission; retain an explicit prepared command when recovery may be needed.

`prepareControl('interrupt'|'closeScope', {observation, operationId})` builds a scoped control. `control(envelope)` sends it through an explicitly supplied control transport. Global end, recovery, scene creation and other administrative operations remain host-owned core operations.

`InteractionTransportError` has `code`, `operation`, `uncertain`, optional `operationId` and the exact detached `command` or `control`. Mutations with a missing or malformed outcome are uncertain, including native `ACKNOWLEDGEMENT_LOST`. Known pre-admission errors retain their codes. No automatic retry or rebase occurs. Applications must not present an uncertain action as definitely failed or repeat it under a new ID.

## Host

`createInteractionHost({runtime, getContext, sceneId, scopeId, viewId?, actions})` creates a synchronous boundary. `getContext()` is called afresh on every invocation and must return trusted application permissions. Administrative grants, other scenes/scopes/actions and non-public audiences are not forwarded. Client JSON cannot supply context. Registered domain validators remain authoritative; action parameter schemas describe the public tool contract, and must be kept consistent with those validators.

The host exposes the transport methods above and `receiveReceipt(receipt)`. It does not expose snapshots, replay exports, arbitrary model tools, JavaScript evaluation or effect claims. Receipts require current trusted receipt permission and the configured boundary; native effect metadata and delivery-layer rules are checked by the core.

The scope must be dedicated to the host boundary because native cancellation applies across every scene that shares a scope. Commands enforce optional view epoch and interaction revision. Scoped controls enforce runtime fence, control revision and scope epoch, and check the configured view ID. They do not separately enforce view epoch/revision. A real view rebind increments control revision, making an unchanged earlier control observation stale. Exact same-ID retries return the original outcome before native freshness checks.

Outcome lookup protects an instance-local set of IDs admitted through that host. After host recreation, an exact resubmission establishes admission again and retains native idempotency. Changed payloads using an existing ID do not authorize lookup. This set is not durable and does not replace a production operation-identity store.

## Versioning and state

The SDK release and the native wire protocol are both `0.1.0`, but are separate version contracts. This pre-1.0 SDK may change through minor releases. Raw core JSON schemas are in `eirvio/contracts/schemas.json`; the core validator supports only the keywords used by that packet.

The native kernel is synchronous and uses Node's hashing primitive. Import the browser client through `eirvio`; import the host or core only into trusted Node code. Browser and host share JSON contracts, not administrative process objects.
