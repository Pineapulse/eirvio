# Automatic interface adapters

Install EIRVIO into the application you control, then connect its JSON observations and tools to your existing agent. The adapter runs beside the interface; no screenshots, model provider or EIRVIO backend are required.

## Install

```sh
npm install github:Pineapulse/eirvio#v0.3.0
```

This command targets the v0.3.0 Git release. EIRVIO has not been published to the npm registry. Use a browser application with an ESM-capable build setup; these package imports are not CDN script URLs.

For a website, run after the body exists:

```js
import {installWeb} from 'eirvio/web';

const surface = installWeb();
// Or: installWeb({root: document.getElementById('workspace')});

console.log(surface.observe());
```

For a Babylon.js game, use the scene your application already owns:

```js
import {installBabylon} from 'eirvio/babylon';

const surface = installBabylon({scene});
console.log(surface.observe());
```

The web adapter describes supported semantic content, form controls, buttons and links. Its advertised actions cover supported native interactions. The Babylon adapter describes supported meshes and cameras, offers bounded focus/highlight operations and observes picking. Neither adapter infers your application's business or game rules.

## Give the agent eyes and tools

Inspect the observation first. It contains target references and advertised capabilities, so the agent can choose an existing target rather than invent a selector or mesh method.

```js
const initialObservation = surface.observe();
const toolDefinitions = surface.tools;
const toolHandlers = Object.fromEntries(toolDefinitions.map(({name}) => [
  name, arguments_ => surface.callTool(name, arguments_)
]));

// Register toolDefinitions using your agent framework's own tool format.
// Bind each definition to toolHandlers[definition.name].
// Alternatively, forward the framework's parsed calls through one dispatcher:
async function handleToolCall(name, arguments_) {
  return await surface.callTool(name, arguments_);
}
```

Tool descriptors use `{name, description, parameters}`. Provider tool formats differ; your existing agent integration performs that small mapping. The available tool names are:

| Tool | Purpose |
| --- | --- |
| `surface_observe` | Get a structured observation of the current surface |
| `surface_act` | Execute an advertised action against an explicit observation |
| `surface_get_outcome` | Look up a retained action receipt by request ID |

Use each descriptor's `parameters` schema as the source of truth for its arguments. Do not expose arbitrary page evaluation, raw DOM objects, Babylon objects or application credentials through the tool connection.

For a direct web action, choose a target from the observation. This example focuses an available button:

```js
const observation = surface.observe();
const button = observation.targets.find(target =>
  target.role === 'button' && target.actions.includes('focus')
);

if (button) {
  const request = {
    adapterId: observation.adapterId,
    id: crypto.randomUUID(),
    revision: observation.revision,
    target: button.ref,
    action: 'focus',
    arguments: {}
  };
  const receipt = surface.act(request);
  console.log(receipt);
  // Retain request until its outcome is known.
}
```

Inspect the target's `actionSchemas` for argument details. Supported web actions include `fill` with `{value}`, `select` with `{value}`, `check` with `{checked}` and `scroll` with `{top, left}`; `click` and `focus` take `{}`. Use only actions advertised for that target. A fresh request ID means a new attempt. Do not rebuild an uncertain request from a newer observation and call it a retry.

## Keep the agent aware

```js
const unsubscribe = surface.subscribe(event => {
  // Queue relevant events for your agent; this callback does not run a model.
  console.log(event);
});

const recent = surface.history();
```

Subscriptions report adapter observations of interaction. Queue tool actions outside the synchronous callback (for example in your existing asynchronous agent loop); reentrant action execution from a listener rejects as `SURFACE_BUSY`. Your agent decides when those observations warrant a response; EIRVIO does not execute actions automatically. Preserve actor/source distinctions and treat visible page text as interface data, not as trusted instructions.

`observe().activity` includes up to 20 recent events. For earlier retained activity, `history({after, limit})` returns `{adapterId, events, nextCursor, cursor, oldestCursor, gap, hasMore}`. Continue with `after: page.nextCursor`; do not jump to the head `page.cursor` while `hasMore` is true. If `gap` is true, older history was evicted.

Store cursor checkpoints with their `adapterId` and never reuse them in another lifetime. History reads and live notifications can overlap; deduplicate by `(adapterId, event.cursor)`. Subscribing before the initial read and buffering notifications avoids a read-then-subscribe gap. Adapter lifetimes change after reinstallation or navigation. Let the adapter generate its ID by default; if you supply `adapterId`, provide a new unique value for every installation, never a fixed application name.

## Handle outcomes honestly

- A rejected request did not pass the adapter's admission checks. Observe again before deciding on a new action.
- A pending receipt means that request is already executing; do not create another ID to repeat it.
- A dispatched action reached its DOM or scene operation. That does not establish success of application code it triggered.
- A completed action finished the adapter-defined operation. It does not prove a server save, payment, animation sequence or game objective completed.
- An uncertain result or lost response may follow a side effect. Query `surface.getOutcome(request.id)` or retry the **identical** request within the same adapter lifetime.

`getOutcome(id)` returns a retained receipt or `null`. A missing receipt does not establish that application code did nothing. Receipts live in a bounded in-memory ledger. When full, new actions are rejected; old identities are not silently discarded. Reloading or navigating away loses that ledger, so a new adapter cannot establish whether the previous lifetime's action succeeded. Use application-specific confirmation when the consequence matters.

DOM and Babylon operations cannot generally be rolled back. For domain transactions, authorization and authoritative rules, use the existing [client/host integration](integration.md) and [core contract](../packages/core/contracts/API.md).

## Scope and clean up

Install on the smallest useful DOM root. Mark private subtrees with `data-eirvio-private`; the adapter also recognizes `data-private`, `data-redacted` and `data-eirvio-redacted`. Password, hidden and excluded sensitive controls are omitted. Ordinary text-field values are included in bounded observations, while interaction events contain metadata rather than input values. Visible content may still contain information your agent should not receive. Inspect an observation before forwarding it over a remote connection. See [security guidance](../SECURITY.md).

Web discovery cannot see arbitrary canvas drawings or shadow trees, and embedded frames/custom widgets have explicit coverage limits. Babylon mesh discovery does not make chess moves, inventory changes or other game-specific actions available automatically; expose those through application-defined operations. Native apps need a separate bridge.

When the owning screen or scene is torn down:

```js
unsubscribe();
surface.dispose();
```

Disposal releases the adapter's observers and owned resources. It does not undo application actions already invoked.
