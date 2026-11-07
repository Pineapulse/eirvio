# Advanced: integrating authoritative actions and declared events

For automatic website or Babylon discovery, start with the [adapter quickstart](quickstart.md). This guide covers the optional authoritative host and explicitly declared awareness API, which remain useful for application rules and server-owned state.

The integration has two directions. The application reports what the user is doing, and exposes the actions the agent is allowed to perform. Neither direction depends on a particular model or renderer.

## 1. Report meaningful user interactions

Wire `events.track(name, properties, {actor:'user'})` into real application event handlers. Prefer semantic events such as `piece.selected`, `checkout.step_completed` or `form.validation_failed` over raw coordinates. Include stable target IDs and the small set of declared properties the agent needs. A keyboard selection and a pointer selection can publish the same semantic event, with an explicitly declared input-method property when useful.

Create awareness with a surface identity, a closed context schema and initial context. Call `updateContext` when the active screen, selected object or another relevant fact changes. Updates replace the full context. They do not silently merge old fields, execute actions or change permissions.

Use `snapshot()` to give the agent current context and retained user activity. Use `subscribe()` to forward new user activity and context changes into an agent loop or application-owned transport. Avoid triggering a new model request on every low-level input; scheduling and batching belong to the integrating agent.

Awareness is local to the JavaScript process. To use a remote agent, your integration forwards the JSON snapshot/notifications over its authenticated connection. EIRVIO does not create that connection or send analytics. Supply only the context and event properties that the agent should receive; it does not automatically read the DOM or form contents.

## 2. Expose actions the interface can execute

Register allowed operations in the core domain registry and describe them in the host's action catalog. Use explicit names and parameters, such as `interface.showTask({taskId})`, `board.highlightMove({from,to})` or `app.openPanel({panelId})`. The action must run the application's validation and update authoritative state, or produce a declared effect that the application's renderer handles.

The agent calls `catalog()` and `observe()`, prepares a command against that observation, then submits it. The trusted host rechecks permissions and freshness. Render the resulting projected state in the website, game scene or app screen. The task-board example's `interface.showTask` sets `highlightedTaskId`; its DOM view renders that as an agent highlight while keeping the human selection independent.

Use effect receipts when completion of a visual or audio effect matters. A committed state change and finished animation are different milestones. The current SDK host accepts receipts, while effect claiming/dispatch remains a trusted core integration concern.

## Bind attention-sensitive actions to authoritative view state

Awareness context is useful information, not a new authorization or concurrency guard. An agent might read a selected object, wait for a model response, and submit after the user has selected something else. A local awareness update alone cannot reject that command at a remote host.

When selection, navigation or another attention change should invalidate pending work, the trusted application must update the matching core view using its `bindView` control and an increased interaction revision. A command prepared with the previous view then rejects as `STALE_INTERACTION`. The application decides which user changes are significant. Never expose an administrative context or unrestricted `bindView` endpoint to clients or agents.

Read host state and awareness again after an explicit rejection before deciding whether to prepare a new action. Do not silently rebase a stale command. Awareness snapshots and server observations are independently sampled; the SDK does not present them as an atomic transaction.

## Consume a live feed without assuming complete history

Subscribe before reading the first snapshot if you need both retained and live activity. Buffer notifications while processing the snapshot. Deduplicate activity by `(awarenessId, event.cursor)` and context updates by `(awarenessId, contextRevision)`; a live notification may already be represented in the snapshot. On disposal, unsubscribe and release the awareness instance.

Pass a snapshot's `nextCursor` as `after` to resume. `limit` bounds source events scanned, including agent/system events that are excluded from `activities`. An empty activity page can therefore still have `hasMore:true`. Continue using `nextCursor`; never jump straight to `sourceHead` while `hasMore` is true.

If `gap` is true, retained history is incomplete. Use current context and a fresh host observation to resynchronize rather than inventing missed actions. A cursor from another awareness instance is rejected. If you supply an explicit awareness ID, use a new unique ID for each instance lifetime, including after reconnect/reset. Context in a snapshot is current; it is not historical context for every event. Include necessary historical facts in the declared event properties at capture time.

## Handle uncertainty explicitly

Keep each prepared command/control envelope until the outcome is known. A timeout or missing response may follow a successful commit. Look up that operation ID or retry the exact envelope; do not repeat it with a new identity. Neither new user events nor a fresh context snapshot prove that the earlier operation failed.

The demo's recovery controls exercise this distinction for both commands and interruptions. Its human completion event is emitted only after a known committed human action; agent action events remain distinct from human activity.

## Adapter responsibilities

A web integration usually wires DOM/framework event handlers and renders projected state. A Babylon.js integration can wire picking and scene interaction callbacks, then map registered actions/effects to scene state and animations. A native app can implement the same JSON contracts through its own bridge. The `installWeb` and `installBabylon` adapters cover common native interactions automatically. Domain actions and effect rendering remain application integration points; see the [quickstart](quickstart.md).

The host adapter owns identity, permissions, domain validation and trusted view updates. The interface adapter owns input instrumentation, current context, rendering and delivery receipts. The agent owns its reasoning/scheduling and chooses from the declared action catalog. This keeps the two directions usable without letting an event or model response become authority by itself.
