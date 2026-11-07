# Engine learning log

## 2026-11-07 — First comparison against EIRVIO v0.3.0

The first cycle added synthetic website, Babylon and internal-kernel scenarios, then compared the released source with the fixed candidate using identical inputs. No customer data or model training was involved.

| Finding | Before | Improvement and retained evidence |
| --- | --- | --- |
| CSS content visibility | A subtree hidden with `content-visibility: hidden` still exposed its controls and value. | Exclude that subtree from semantic discovery; a dynamic-privacy scenario and DOM regression test retain the case. |
| Reentrant admission | Preflight validation could synchronously submit a second request before the first request held its execution guard. | Guard the admission phase so nested work cannot bypass the current revision check. |
| Disposal during validation | Disposing the adapter inside validation could still allow its pending effect to execute. | Recheck lifecycle before invoking the prepared effect. |
| Semantic fields named `sample` | Revision comparison ignored every nested key named `sample`, including meaningful state or metadata. | Ignore only the designated transient sample fields, while guarding semantic data with that name. |
| Large retained history | A page of individually valid events could exceed the JSON-copy budget and throw instead of returning history. | Bound the returned page and retain a usable continuation cursor. |
| Mutable tool template | Mutating a nested exported tool descriptor could make future adapters advertise an unsupported tool. | Freeze the entire descriptor template and keep detached public copies. |

The Babylon curriculum also exercises moving objects, stale replacements, competing highlights, dropped replies, new-object picks, teardown, thin instances and post-effect exceptions. These cases initially passed on both versions; they are coverage evidence, not claimed fixes.

Machine-readable runs remain local under `reports/lab/`. The learning page reports measured improvements and regressions from its latest completed comparison. Future entries should name an observed failure and its reproducible case, rather than infer improvement from a larger test count.
