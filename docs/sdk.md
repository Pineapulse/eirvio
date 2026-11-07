# SDK API 0.2.0

## Interface awareness

`createInterfaceAwareness({events, surface, contextSchema, initialContext, awarenessId?, maxListeners=100, onListenerError?})` creates a browser-safe, synchronous local awareness source. It observes the supplied stream and retains current app-declared context. It does not execute actions, read interface controls automatically, or open a network connection.

`surface` is `{id, kind: 'website'|'game'|'app', name?}`. `contextSchema` uses the same closed `EventDefinition` dialect as events. Initial context and replacements are plain JSON objects bounded to 16 KiB and depth 8. `awarenessId` defaults to `crypto.randomUUID()`; environments without it must provide a unique ID per instance lifetime. Maximum listener count is configurable from 1 to 10,000.

`updateContext(replacement)` validates and replaces the entire context, increments `contextRevision`, notifies subscribers and returns a detached `{context, contextRevision}`. Rejected updates change neither current context nor revision. A context change does not append a source event; its revision is independent of source event cursors.

`snapshot({after?, limit?})` returns:

| Field | Meaning |
| --- | --- |
| `awarenessId`, `surface` | Identity of this local awareness instance and interface |
| `context`, `contextRevision` | Current declared context; not historical context for each activity |
| `activities` | Events in the scanned page whose descriptive actor is `user` |
| `nextCursor` | `{awarenessId, cursor}` identifying the last source event scanned |
| `sourceHead`, `oldestCursor` | Source head and oldest retained event cursor |
| `gap`, `hasMore` | Whether older history was evicted and whether more source entries remain |

Omit `after` to start from cursor 0. Resume with the preceding `nextCursor`. `limit` counts source entries scanned, including filtered agent/system events; an empty activity page can have `hasMore:true`. Omit it to use the source stream's default, or supply a positive count no greater than its `maxEvents`. A cursor from a different instance rejects with `AWARENESS_CURSOR_MISMATCH`; malformed or future cursors reject with `INVALID_AWARENESS_CURSOR`. Gaps require resynchronization using current context and a fresh host observation.

`subscribe(listener)` returns an unsubscribe function. Notifications are `{type:'activity', awarenessId, event}` or `{type:'context_changed', awarenessId, contextRevision, context}`. Each listener gets detached data. Synchronous throws and promise rejections are isolated and optionally reported through `onListenerError(error, details)`. Register before taking a snapshot when combining replay with live delivery; buffer and deduplicate overlapping activity by `(awarenessId, event.cursor)` and context by revision. See the [integration guide](integration.md).

Reads during notifications are permitted. Reentrant context writes reject with `AWARENESS_REENTRANCY`. If a context listener explicitly publishes to the independently owned source stream, a nested activity notification is isolated/reported to avoid recursion; the event remains readable in snapshot history. Schedule follow-up work outside synchronous notification delivery. This is a local observer, not a durable or exactly-once queue.

`dispose()` is idempotent, releases its upstream subscription and clears its own listeners. Later reads, updates and subscriptions reject with `AWARENESS_DISPOSED`. It does not dispose the shared event stream or cancel promises already running in application listeners.

Awareness grants no authority and does not advance runtime/view guards. Use the existing client/host for actions and trusted view binding for selection-sensitive freshness. Actor labels filter metadata; they do not prove who performed an action.

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

The SDK release is `0.2.0`; the native wire protocol remains `0.1.0`. They are separate version contracts. This pre-1.0 SDK may change through minor releases. Raw core JSON schemas are in `eirvio/contracts/schemas.json`; the core validator supports only the keywords used by that packet.

The native kernel is synchronous and uses Node's hashing primitive. Import the browser client through `eirvio`; import the host or core only into trusted Node code. Browser and host share JSON contracts, not administrative process objects.
