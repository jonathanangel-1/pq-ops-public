# Review PQ Ops

[Overview](../README.md) · [Engineering guide](ENGINEERING.md)

## Start here

Read the [source-fact contract](../lib/source-fact-contract.js), then [operator truth packets](../lib/operator-truth-packet.js). Together they show the distinction between source evidence and a computed operational conclusion. For the deeper pipeline, continue to the [relational reducer](../lib/relational-truth-reducer.js) and [precedence policy](../config/truth-precedence-policy-v1.json).

Use Node.js 24 and a fresh checkout:

```sh
git clone https://github.com/jonathanangel-1/pq-ops-public.git
cd pq-ops-public
npm ci --ignore-scripts
npm run demo
```

Open **http://127.0.0.1:4173**. The original board displays three fictional shipments. The demo server creates its inputs in memory and uses an allowlist for static files. Stop and restart it to clear in-memory draft responses.

## What to inspect

| Shipment | Inspect | Expected result |
| --- | --- | --- |
| `016-90000001` | Arrival, fees, release evidence | Arrival and fees are supported; release is unknown. |
| `016-90000002` | Release versus pickup | Arrival, customs, and fees are supported; arranging pickup is still future work. |
| `016-90000003` | Delivery versus closeout | Delivery is reported; POD remains unknown and collecting it still counts as operator work. |

Open **http://127.0.0.1:4173/shipment-truth-packets.json** to inspect the exact packets serving the board. Each packet includes source-fact IDs, gates, unknowns, contradictions, and agency. Compare it to [the invented input events](../demo/scenarios.js).

The UI may display its normal stale-email warning because no live mailbox is connected. This is expected. The demo does not fabricate a successful Gmail synchronization to clear that warning. Companion responses are explicitly synthetic, and draft responses remain in memory.

## Reproduce the automated checks

```sh
npm run test:public
npm run build
```

[The public regression](../demo/verify.js) invokes actual source/packet/agency logic. It checks:

- Unique fictional shipment inventory and durable-looking fictional message references.
- Release unknown despite arrival; pickup unconfirmed despite release.
- Promised POD versus received POD.
- Delivery without POD remaining actionable in both packet and row classifiers.
- Completed proof allowing monitoring.
- Generated canonical, packet, UI, and action-planner conclusions rejected as new evidence, even with a copied source pointer.

The asset build validates the shipped interface bundle. [GitHub Actions](https://github.com/jonathanangel-1/pq-ops-public/actions/workflows/public-checks.yml) runs both commands on Node.js 24/Linux.

## What this does not establish

The demo does not run Gmail OAuth, carrier tracking, AI extraction, Supabase migration application, the relational refresh/publication infrastructure, or live action execution. Those implementations remain in the repository for review and independent configuration.

The public regression is deliberately small and based on synthetic cases. It does not establish extraction accuracy on historical emails, operational throughput, recovery behavior during a provider outage, or exhaustive correctness of the large application. Other retained maintenance and verification scripts can require the original environment or excluded datasets; the commands above define the keyless review contract.

See [the engineering guide](ENGINEERING.md) for design tradeoffs and [the data boundary](PUBLIC_DATA.md) for how this copy was prepared.
