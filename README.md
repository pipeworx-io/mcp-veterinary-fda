# Veterinary FDA — Animal Drug Adverse Events, Pet Product Recalls, Pet Services

Side-effect reports, product recalls, and nearby pet services for the animal/veterinary side of the world — dogs, cats, horses, cattle. Two sources: openFDA's Center for Veterinary Medicine adverse-event database (985,705 Dog / 148,091 Cat reports as of 2026-09-04, keyless) and OpenStreetMap (vets, dog parks, pet stores, shelters). No pack in the MCP ecosystem serves the animal adverse-event data before this one — `openfda` never touches it.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1509+ live data sources.

## Why this matters for AI agents

"Is this side effect from my dog's flea medication normal?" and "has this dog food been recalled?" are questions people actually ask, and until now nothing answered them from primary-source FDA data.

Common flows:

- **Side effects for a drug.** "What side effects have been reported for Bravecto in dogs?" → `vet_adverse_events({drug: "Bravecto", species: "Dog"})` → individual reports with reactions, outcome, dose.
- **Aggregate safety picture.** "How common are seizures with fluralaner in dogs?" → `vet_adverse_event_summary({active_ingredient: "fluralaner", species: "Dog"})` → counts by reaction, outcome, year.
- **Recalls.** "Has Blue Buffalo dog food been recalled?" → `vet_product_recalls({product: "Blue Buffalo"})`.
- **Nearby services.** "Emergency vet near Austin TX" → `pet_services_near({place: "Austin TX", kind: "emergency_vet"})`.

## Auth

Public, keyless. api.fda.gov runs on api-umbrella (the same api.data.gov stack as `openfda`), so the gateway injects `PLATFORM_DATAGOV_KEY` (`workers/gateway/src/index.ts`, `MCP_PACKS` entry for `veterinary-fda`) to raise the anonymous 40 req/min · 1,000/day cap to 120,000/day — the same platform key already backing 15 other federal packs (openfda, fac, nasa, govinfo, regulations-gov, etc.). Bring your own key with `_apiKey` to draw on your own quota instead. A rejected/revoked platform key falls back to anonymous rather than failing the call.

Nominatim (geocoding) and Overpass (`pet_services_near`) are separately keyless, public OSM infrastructure.

## Tools

| Tool | What it answers |
|---|---|
| `vet_adverse_events` | Individual animal adverse-event reports for a drug/species |
| `vet_adverse_event_summary` | Counts by reaction, outcome, and year for a drug/species pair |
| `vet_product_recalls` | FDA Enforcement Report recalls for a pet food or veterinary drug product |
| `pet_services_near` | Nearby vets, emergency vets, dog parks, pet stores, shelters (OpenStreetMap) |

## Data traps (measured 2026-09-04, load-bearing for how these tools are built)

- **`drug.brand_name` is near-useless.** In the adverse-event endpoint it almost always holds the registrant's internal short code (e.g. `"MSK"` for Merck Animal Health), not the marketed product name. Searching `drug.brand_name` for "Bravecto", "Frontline", "Heartgard", or "Simparica" returns **zero** matches for all four. The actual product name is recorded inside `drug.active_ingredients.name` instead (mixed in with real chemical ingredient names — messy upstream data). `vet_adverse_events`/`vet_adverse_event_summary` try `brand_name` first, then fall back to `active_ingredients.name` automatically and report `resolved_from` so the caller knows which field actually matched.
- **`count=<field>.exact` is per-field, not universal.** `count=reaction.veddra_term_name.exact` and `count=outcome.medical_status.exact` both work; `count=animal.species.exact` and `count=original_receive_date.exact` both return `"Nothing to count"`. `vet_adverse_event_summary`'s by-year table works around the date-field limitation by requesting `count=original_receive_date` (which buckets per exact DAY, not year) and aggregating client-side.
- **Bare multi-word terms are an OR, not an AND, and openFDA does not rank by relevance.** `search=product_description:dog+food` (no quotes) matches ~29,000 records — mostly hot dogs and corn dogs, because "dog" OR "food" hits practically the whole food-recall corpus, returned in whatever order openFDA feels like. Only the phrase-quoted form, `search=product_description:"dog food"`, returns the real 2 pet-food matches (Freshpet). `vet_product_recalls` always phrase-quotes multi-word product terms for this reason, and never falls back to a loose OR match — for a recall/safety answer, a false-positive (a "Blue Bell" ice-cream recall surfacing for a "Blue Buffalo" query) is worse than an honest zero, so unlike this pack's own adverse-event fallback and unlike `openfda`'s free-text fallback, there is no loose-match tier here.
- **Pet-food recall coverage in openFDA is genuinely incomplete, not a search-syntax problem.** There is no dedicated animal/pet-food recall endpoint — `vet_product_recalls` reuses `food/enforcement.json` and `drug/enforcement.json`, the same feeds `openfda` uses for human food/drugs. Several well-known, FDA-confirmed pet-food recalls are **absent from this dataset entirely**, verified by exhausting every plausible product/firm-name spelling (including the exact names from FDA's own press releases) rather than by a single failed query: Blue Buffalo's 2010/2017/2022 recalls and the 2021 Sportmix aflatoxin recall (~70 dog deaths, a formal FDA Class I recall) all return **zero** records under any search. FDA's own recall-history page (`fda.gov/animal-veterinary/safety-health/recalls-withdrawals`) is not the same backing data as openFDA's Enforcement Reports API, and openFDA does not mirror it. `vet_product_recalls` returns `total: 0` plus an explicit note in that case — treat a zero as "no Enforcement Report record found," never as "never recalled."
- **`emergency=yes` is under-tagged in OpenStreetMap.** Many real emergency vet clinics simply aren't tagged that way. `pet_services_near({kind: "emergency_vet"})` falls back to all nearby veterinary clinics (with a note) rather than returning a false "none found" when the emergency-tagged search comes up empty.

## Example questions this pack should answer

- "What side effects have been reported for Bravecto in dogs?"
- "How many adverse events for fluralaner in cats, and what happened to them?"
- "Has Blue Buffalo dog food been recalled?"
- "Emergency vet near Austin TX"
- "Dog parks near Portland OR"

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "veterinary-fda": {
      "url": "https://gateway.pipeworx.io/veterinary-fda/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/veterinary-fda/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1509+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Veterinary Fda data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
