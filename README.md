# EIRVIO

**Event-Instrumented Runtime for Verified Interface Operations.**

Give your agent structured eyes and actions inside your website or Babylon.js game—without screenshots. EIRVIO discovers supported interface objects, describes what the agent can do with them, and reports interactions as they happen. Connect these capabilities to the agent you already use.

**Early release · MIT · JavaScript ESM + TypeScript declarations.** The automatic adapters run in the browser. They do not require an EIRVIO server, model account or analytics service. The optional transactional host requires Node.js 22 or newer.

## Install in a website

```sh
npm install github:Pineapulse/eirvio#v0.3.1
```

GitHub is the release channel. EIRVIO is **not published to the npm registry**. This installation targets the v0.3.1 Git release.

Run this in your browser application after the page body exists:

```js
import {installWeb} from 'eirvio/web';

const surface = installWeb(); // defaults to document.body
console.log(surface.observe());

const unsubscribe = surface.subscribe(event => {
  // Forward relevant observations to your agent's context queue.
  console.log(event);
});
```

The web adapter discovers supported semantic content and controls automatically. It offers actions such as clicking, focusing, filling, selecting and scrolling where supported. You can limit installation to part of the page with `installWeb({root: element})`.

## Install in a Babylon.js game

```js
import {installBabylon} from 'eirvio/babylon';

const surface = installBabylon({scene}); // your existing Babylon.js scene
console.log(surface.observe());
```

The Babylon adapter exposes supported scene objects, observes picking, and offers camera focus and highlighting where supported. A mesh description is not a game rule: moves, inventory changes and other game-specific operations still need application-defined actions.

## Connect your existing agent

Both adapters expose the same tool bridge:

```js
const tools = surface.tools;
// [{name, description, parameters}, ...]

async function executeAgentTool(name, arguments_) {
  return await surface.callTool(name, arguments_);
}
```

Map `tools` into your agent framework's tool format and route its tool calls through `executeAgentTool`. The tools are `surface_observe`, `surface_act` and `surface_get_outcome`. Their descriptors contain the actual argument schemas. EIRVIO does not start an agent or assume a provider-specific tool format.

The agent observes the surface, chooses an advertised action and submits its opaque target reference with the observed revision. Events supply context; they never execute an action automatically. The [quickstart](docs/quickstart.md) covers installation, event handling and action outcomes.

## What the adapters guarantee

An action uses an adapter lifetime ID, a unique request ID, an observed revision and an opaque target reference. The adapter checks the request against its current surface. It retains accepted request identities within a bounded in-memory ledger: exact retries return the original receipt, and reusing an ID with changed arguments is rejected. A full ledger rejects new actions instead of evicting old identities.

DOM and scene actions are **not transactions**. A click can trigger application code, submit a form or navigate away. `dispatched` means invocation occurred; `completed` means the adapter's operation completed, not that a purchase, save or game objective succeeded. After a missing reply, preserve the exact request and query its outcome. A reload or navigation creates a new adapter lifetime and loses the old local ledger.

“Verified” refers to the checks implemented by the selected integration. Automatic adapters validate inputs, target identity and freshness; the optional host also checks application-supplied authorization and domain rules. The term does not mean formal verification.

## Coverage and privacy

- Web discovery uses supported DOM semantics. It does not provide screenshots, arbitrary JavaScript execution or arbitrary selector execution.
- Password, hidden and marked-private content are excluded. Scope installation to the intended interface and review the resulting observation before forwarding it outside the page. Ordinary visible page content can still contain personal information.
- Canvas drawings, shadow trees, embedded frames and custom widgets may need dedicated integrations. A browser adapter does not provide native desktop or mobile application automation.
- Babylon discovery does not infer game rules or turn arbitrary mesh methods into tools. Advertised capabilities describe the operations the installed adapter supports.
- Events are observations, not authentication or proof of user intent. Production authorization and any remote-agent transport remain application responsibilities.

## Advanced integrations

For applications that already have semantic events and domain actions, the existing APIs remain available:

| Entry point | Purpose |
| --- | --- |
| `eirvio/web` | Automatic DOM discovery, actions and interaction observations |
| `eirvio/babylon` | Babylon scene discovery, bounded actions and picking observations |
| `eirvio` | Explicit event streams, interface awareness and the guarded action client |
| `eirvio/host` | Trusted Node boundary for projected state and authorized domain actions |
| `eirvio/core` | Transactional domain transitions, scopes, effects, receipts and replay |
| `eirvio/contracts/*` | Native core protocol schemas and examples |

The core's `MemoryStore` is in memory; it does not supply process-crash durability. Native core commands and automatic adapter actions have different execution guarantees. See the [integration guide](docs/integration.md), [SDK API](docs/sdk.md) and [core contract](packages/core/contracts/API.md).

To run the demonstrations from a clone:

```sh
npm ci
npm run check
npm start
```

Open [localhost:8810](http://127.0.0.1:8810/) for automatic website discovery and the Babylon scene demonstration. Startup builds the local Babylon demo bundle from the development dependencies. The [advanced task board](http://127.0.0.1:8810/task-board) demonstrates explicit awareness, guarded actions and lost-reply recovery. These demos use scripted agents and need no model credentials; `npm run demo` runs the advanced terminal example.

See [provenance](docs/provenance.md), [security](SECURITY.md) and [contributing](CONTRIBUTING.md).

## Test and improve the engine

From a repository checkout, run `npm run lab:test` for isolated scenario checks, `npm run lab:learn` to compare the published v0.3.0 baseline with your current engine, and `npm run lab:serve` to open the testing environment on port 8811 and learning environment on port 8812. The learning comparison retains reproducible failures and measured improvements; it does not train a model. See the [lab guide](docs/testing.md) and [learning log](docs/learning-log.md).
