# Veterinary FDA — Approved Animal Drugs, Adverse Events, Pet Product Recalls, Pet Services

Approved animal drugs, side-effect reports, product recalls, and nearby pet services for the animal/veterinary side of the world — dogs, cats, horses, cattle. Three sources: the **FDA Green Book** (Animal Drugs @ FDA — the official list of approved new animal drug applications, keyless), openFDA's Center for Veterinary Medicine adverse-event database (985,705 Dog / 148,091 Cat reports as of 2026-09-04, keyless) and OpenStreetMap (vets, dog parks, pet stores, shelters). No pack in the MCP ecosystem serves the animal adverse-event data before this one — `openfda` never touches it, and `openfda`'s drug endpoints are human-drug only, so the Green Book side is likewise unserved.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1576+ live data sources.

Together these answer one question sequence end to end: **what is approved for this animal** (Green Book) → **what has it done to animals** (adverse events) → **has it been recalled** (enforcement reports).

## Why this matters for AI agents

"Is this side effect from my dog's flea medication normal?" and "has this dog food been recalled?" are questions people actually ask, and until now nothing answered them from primary-source FDA data.

Common flows:

- **What is approved.** "What FDA-approved drugs contain carprofen?" → `animal_drug_search({query: "carprofen"})` → 24 approved applications with sponsor, status and approval date. "What is approved for dogs?" → `animal_drug_search({species: "Dogs"})` → 694.
- **What an approval actually covers.** "What was Rimadyl approved for?" → `animal_drug_search({brand_name: "Rimadyl"})` → applicationId 1024 → `animal_drug_detail({application_id: 1024})` → FDA's own FOI approval summaries, per-species dosage and indications, and the labelling PDFs.
- **Side effects for a drug.** "What side effects have been reported for Bravecto in dogs?" → `vet_adverse_events({drug: "Bravecto", species: "Dog"})` → individual reports with reactions, outcome, dose.
- **Aggregate safety picture.** "How common are seizures with fluralaner in dogs?" → `vet_adverse_event_summary({active_ingredient: "fluralaner", species: "Dog"})` → counts by reaction, outcome, year.
- **Recalls.** "Has Blue Buffalo dog food been recalled?" → `vet_product_recalls({product: "Blue Buffalo"})`.
- **Nearby services.** "Emergency vet near Austin TX" → `pet_services_near({place: "Austin TX", kind: "emergency_vet"})`.

## Auth

Public, keyless throughout.

The **Green Book** tools (`animal_drug_*`) call `animaldrugsatfda.fda.gov` directly — the Animal Drugs @ FDA SPA's own backing API. It is a different upstream from openFDA: no key applies to it, `PLATFORM_DATAGOV_KEY` is not sent, and `_apiKey` does nothing there.

api.fda.gov runs on api-umbrella (the same api.data.gov stack as `openfda`), so the gateway injects `PLATFORM_DATAGOV_KEY` (`workers/gateway/src/index.ts`, `MCP_PACKS` entry for `veterinary-fda`) to raise the anonymous 40 req/min · 1,000/day cap to 120,000/day — the same platform key already backing 15 other federal packs (openfda, fac, nasa, govinfo, regulations-gov, etc.). Bring your own key with `_apiKey` to draw on your own quota instead. A rejected/revoked platform key falls back to anonymous rather than failing the call.

Nominatim (geocoding) and Overpass (`pet_services_near`) are separately keyless, public OSM infrastructure.

## Tools

| Tool | What it answers |
|---|---|
| `animal_drug_search` | Which FDA-approved animal drugs match an ingredient, species, sponsor, brand, indication or status |
| `animal_drug_detail` | Everything on one approved application: products, species, dosage, indications, FOI approval summaries, labelling PDFs |
| `animal_drug_monthly_updates` | The Green Book monthly change PDFs (new approvals, withdrawals, labelling changes) |
| `vet_adverse_events` | Individual animal adverse-event reports for a drug/species |
| `vet_adverse_event_summary` | Counts by reaction, outcome, and year for a drug/species pair |
| `vet_product_recalls` | FDA Enforcement Report recalls for a pet food or veterinary drug product |
| `pet_services_near` | Nearby vets, emergency vets, dog parks, pet stores, shelters (OpenStreetMap) |

## Data traps (measured 2026-09-04, load-bearing for how these tools are built)

- **`drug.brand_name` is near-useless.** In the adverse-event endpoint it almost always holds the registrant's internal short code (e.g. `"MSK"` for Merck Animal Health), not the marketed product name. Searching `drug.brand_name` for "Bravecto", "Frontline", "Heartgard", or "Simparica" returns **zero** matches for all four. The actual product name is recorded inside `drug.active_ingredients.name` instead (mixed in with real chemical ingredient names — messy upstream data). `vet_adverse_events`/`vet_adverse_event_summary` try `brand_name` first, then fall back to `active_ingredients.name` automatically and report `resolved_from` so the caller knows which field actually matched.
- **`count=<field>.exact` is per-field, not universal.** `count=reaction.veddra_term_name.exact` and `count=outcome.medical_status.exact` both work; `count=animal.species.exact` and `count=original_receive_date.exact` both return `"Nothing to count"`. `vet_adverse_event_summary`'s by-year table works around the date-field limitation by requesting `count=original_receive_date` (which buckets per exact DAY, not year) and aggregating client-side.
- **Bare multi-word terms are an OR, not an AND, and openFDA does not rank by relevance.** `search=product_description:dog+food` (no quotes) matches ~29,000 records — mostly hot dogs and corn dogs, because "dog" OR "food" hits practically the whole food-recall corpus, returned in whatever order openFDA feels like. Only the phrase-quoted form, `search=product_description:"dog food"`, returns the real 2 pet-food matches (Freshpet). `vet_product_recalls` always phrase-quotes multi-word product terms for this reason, and never falls back to a loose OR match — for a recall/safety answer, a false-positive (a "Blue Bell" ice-cream recall surfacing for a "Blue Buffalo" query) is worse than an honest zero, so unlike this pack's own adverse-event fallback and unlike `openfda`'s free-text fallback, there is no loose-match tier here.
- **Pet-food recall coverage in openFDA is genuinely incomplete, not a search-syntax problem.** There is no dedicated animal/pet-food recall endpoint — `vet_product_recalls` reuses `food/enforcement.json` and `drug/enforcement.json`, the same feeds `openfda` uses for human food/drugs. Several well-known, FDA-confirmed pet-food recalls are **absent from this dataset entirely**, verified by exhausting every plausible product/firm-name spelling (including the exact names from FDA's own press releases) rather than by a single failed query: Blue Buffalo's 2010/2017/2022 recalls and the 2021 Sportmix aflatoxin recall (~70 dog deaths, a formal FDA Class I recall) all return **zero** records under any search. FDA's own recall-history page (`fda.gov/animal-veterinary/safety-health/recalls-withdrawals`) is not the same backing data as openFDA's Enforcement Reports API, and openFDA does not mirror it. `vet_product_recalls` returns `total: 0` plus an explicit note in that case — treat a zero as "no Enforcement Report record found," never as "never recalled."
### Green Book traps (measured 2026-09-05)

- **`/advancedSearch` silently DISCARDS `basicSearchTerm`.** This is the dangerous one: it is not an error, it is a 200 with confidently wrong rows. `{basicSearchTerm: "carprofen", speciesName: "Cats"}` returns **338** results led by Pentobarbital Sodium — the entire Cats set, with the free-text term dropped on the floor — instead of the carprofen∩cats intersection. Nothing in the response says the term was ignored. `animal_drug_search` therefore never forwards free text to `/advancedSearch`: when `query` arrives alongside a structured filter it is resolved into `activeIngredientName` (then `proprietaryName` if that is empty) and the response reports which, via `query_resolved_to`.
- **`totalPages` is always `1`, whatever the real count.** 694 dog rows at `pageSize: 2` still reports `totalPages: 1`. Trusting it truncates every large result set to one page. `animal_drug_search` recomputes it from `totalElements / page_size`.
- **`publishDate` and `voluntaryWithdrawalDate` are epoch MILLISECONDS**, not seconds — read as seconds they land in 1970. Rendered as `YYYY-MM-DD`.
- **`applicationStatusValue` is always `null` in list rows.** Only `applicationStatusCode` (a bare `A`/`W`/`G`/`R`) is populated, so a pass-through renders every result status-unknown. Decoded against `/codes/application_status` (memoised per isolate, with a hardcoded fallback table so a blip on a 4-row lookup can never degrade a status to a bare letter).
- **`proprietaryName` can carry embedded newlines** — `"Carprofen Caplets\nNovox® Caplets"` is one row marketing two names. Returned both as `proprietary_names[]` and as a first-name `proprietary_name`.
- **`/retrievePreviewBean/{id}` answers an unknown id with a 500 and an HTML Weblogic error page**, which naively classifies as `upstream_down` — reporting FDA as down when the caller simply passed a bad id (or passed the NADA number where the applicationId was wanted). `animal_drug_detail` checks `/preview/{id}` first, which answers the same id with a clean 200 and `applicationId: null`, and raises a bad-argument error naming the distinction.
- **`/retrievePreviewBean`'s own `application` block is unusable** — `applicationNumber: 0`, type and status `null`, even for a valid id. The rich content is real; the identity fields have to come from `/preview/{id}`. Neither endpoint alone is sufficient.
- **`/specandstatus/{id}` is NOT wired, deliberately.** `specandstatus/1024` returns a chlortetracycline VFD record unrelated to application 1024 (Rimadyl) — it appears to key on a different id space. Left out rather than shipped as a plausible-looking wrong answer.
- **Document downloads are on three different path shapes**, all verified 200 `application/pdf`: `/document/downloadFoi/{foiId}`, `/document/downloadLabeling/{labelingId}`, and — not under `/document/` at all — `/monthlyUpdates/downloadMonthlyUpdate/{greenbookMonthlyUpdatesId}`.

### Other traps

- **`emergency=yes` is under-tagged in OpenStreetMap.** Many real emergency vet clinics simply aren't tagged that way. `pet_services_near({kind: "emergency_vet"})` falls back to all nearby veterinary clinics (with a note) rather than returning a false "none found" when the emergency-tagged search comes up empty.

## Example questions this pack should answer

- "What FDA-approved drugs contain carprofen?"
- "What drugs are approved for dogs?"
- "What was Rimadyl approved for, and when?"
- "Which animal drugs has Zoetis had withdrawn?"
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

Both URLs reach the same gateway and the same 1576+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/vet_adverse_events \
  -H 'Content-Type: application/json' \
  -d '{"drug":"Bravecto","species":"Dog"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/vet_adverse_events`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "veterinary-fda": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-veterinary-fda"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-veterinary-fda
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

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
