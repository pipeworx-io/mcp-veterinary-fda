interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * Written as a sentence rather than a sigil because it is going to be read by
 * whoever gets the error, and "our own service, not a third party" is the
 * single most useful thing to tell them — fetchWithTimeout's own comment
 * (fleet #1047) is about exactly this ambiguity, where blaming a healthy vendor
 * by name sent the next person waiting for an outage that did not exist.
 */
const INTERNAL_ORIGIN_MARKER = ' [pipeworx-hosted origin — our own service, not a third party]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * Veterinary FDA MCP — openFDA Animal & Veterinary adverse events, pet/animal
 * food & drug recalls (openFDA Enforcement Reports), and pet services nearby
 * (OpenStreetMap via Overpass).
 *
 * Tools:
 * - vet_adverse_events: search animal drug adverse-event reports (species,
 *   drug/active ingredient, reaction, breed)
 * - vet_adverse_event_summary: counts by reaction, outcome, and year for a
 *   drug/species pair
 * - vet_product_recalls: FDA Enforcement Report recalls scoped to pet/animal
 *   food or veterinary drugs
 * - pet_services_near: nearby vets, emergency vets, dog parks, pet stores,
 *   and shelters via OpenStreetMap/Overpass
 * - animal_drug_search / animal_drug_detail / animal_drug_monthly_updates:
 *   FDA-APPROVED animal drugs from the Green Book (Animal Drugs @ FDA). This
 *   is a SECOND upstream, unrelated to openFDA and needing no key — see the
 *   Green Book section further down for its own traps. It completes the
 *   question sequence the rest of the pack starts: what is approved for this
 *   animal, what has it done to animals, and has it been recalled.
 *
 * Source: api.fda.gov/animalandveterinary (985,705 Dog / 148,091 Cat adverse
 * event reports as of 2026-09-04, updated as FDA receives them) and
 * api.fda.gov/food+drug/enforcement.json (FDA Enforcement Reports).
 * api.fda.gov runs on api-umbrella (the api.data.gov stack): anonymous
 * callers get 1,000 requests/day per IP, shared across everything egressing
 * from the same address; the gateway injects PLATFORM_DATAGOV_KEY (one key
 * shared by 15 other federal packs incl. openfda) to raise that to
 * 120,000/day. See apiKeyOf()/withApiKey() below — same pattern as mcps/openfda.
 *
 * DATA TRAP, measured 2026-09-04: drug.brand_name in the adverse-event
 * endpoint is near-useless — it almost always holds the REGISTRANT's short
 * code (e.g. "MSK" for Merck Animal Health), not the marketed product name.
 * "Bravecto", "Frontline", "Heartgard", "Simparica" all return zero matches
 * against drug.brand_name but DO appear inside drug.active_ingredients.name
 * (which mixes real active-ingredient names with product/brand names — messy
 * upstream data, not a bug here). So every drug/brand lookup in this pack
 * searches active_ingredients.name first and reports how it resolved.
 *
 * DATA TRAP #2, measured 2026-09-04: pet/animal food recalls are covered
 * VERY UNEVENLY by openFDA's Enforcement Reports (food/enforcement.json,
 * drug/enforcement.json) — there is no dedicated animal-food recall
 * endpoint. Some pet-food recalls appear (e.g. Freshpet refrigerated dog
 * food, under a `"dog food"` PHRASE match), but several major, FDA-confirmed
 * pet-food recalls (Blue Buffalo's 2010/2017/2022 recalls, the 2021 Sportmix
 * aflatoxin recall) return ZERO records under every field/phrasing tried
 * (product_description, recalling_firm, exact company names from FDA's own
 * press releases) — verified by exhausting the plausible search terms, not a
 * syntax miss. FDA's own https://www.fda.gov/animal-veterinary/safety-health/recalls-withdrawals
 * page lists these; that page is NOT the same backing data as openFDA's
 * Enforcement Reports API, and openFDA does not mirror it. So a zero here
 * means "no FDA Enforcement Report record", not "never recalled" — the
 * tool's response says so explicitly rather than presenting a silent zero as
 * a clean "no recalls" answer. It is why the tool never falls back to a
 * loose OR match (unlike vet_adverse_events/openfda's free-text fallback):
 * for a recall/safety query, a false-positive match (e.g. a "Blue Bell"
 * ice-cream recall surfacing for a "Blue Buffalo" query) is worse than an
 * honest zero.
 *
 * A second bare-term trap applies here too: `product_description:dog food`
 * WITHOUT quotes is not an AND — it OR-matches "dog" (found in thousands of
 * "hot dog"/"corn dog" human-food recalls) and "food", so an unquoted query
 * for "dog food" returns ~29,000 mostly-irrelevant rows as a clean 200. Only
 * the quoted PHRASE `product_description:"dog food"` returns the real pet
 * food matches (2, both Freshpet). This tool always phrase-quotes multi-word
 * product terms for that reason.
 */


async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Veterinary FDA');
}

const BASE = 'https://api.fda.gov';

/* ── Tool definitions ─────────────────────────────────────────────── */

const tools: McpToolExport['tools'] = [
  {
    name: 'vet_adverse_events',
    description:
      'Search FDA (openFDA Center for Veterinary Medicine) reports of side effects/adverse events in animals given a veterinary drug or parasite preventive — dogs, cats, horses, cattle. Answers "what side effects has Bravecto caused in dogs", "adverse events for fluralaner in cats", "has anyone reported seizures after ivermectin in dogs". Pass a brand/product name via "drug" OR a chemical active ingredient via "active_ingredient" (either works — the tool resolves brand names against the ingredient field, since that is where product names are actually recorded upstream). Reports are spontaneous submissions, not a validated causal or incidence study.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        drug: { type: 'string', description: 'Brand/product name, e.g. "Bravecto", "Frontline", "Heartgard".' },
        active_ingredient: { type: 'string', description: 'Chemical active ingredient, e.g. "fluralaner", "ivermectin", "moxidectin". Use this OR "drug".' },
        species: { type: 'string', description: 'Animal species: Dog, Cat, Horse, Cattle, Swine, etc. Case-insensitive.' },
        reaction: { type: 'string', description: 'Optional: filter to a specific reaction/symptom, e.g. "vomiting", "seizure", "lethargy".' },
        breed: { type: 'string', description: 'Optional: filter to a breed, e.g. "German Shepherd", "Labrador".' },
        since: { type: 'string', description: 'Optional: only reports received on/after this date, YYYY-MM-DD.' },
        limit: { type: 'number', description: 'Max reports to return (1-50, default 10).' },
      },
      required: ['species'],
    },
  },
  {
    name: 'vet_adverse_event_summary',
    description:
      'Count FDA (openFDA Center for Veterinary Medicine) animal adverse-event reports for a drug/species pair, broken down by reaction (top 20), outcome (recovered/died/euthanized/ongoing), and by year. Answers "how many adverse events for Bravecto in dogs", "what are the most common side effects of fluralaner", "has fluralaner caused deaths in dogs". Pass a brand/product name via "drug" OR a chemical active ingredient via "active_ingredient".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        drug: { type: 'string', description: 'Brand/product name, e.g. "Bravecto".' },
        active_ingredient: { type: 'string', description: 'Chemical active ingredient, e.g. "fluralaner". Use this OR "drug".' },
        species: { type: 'string', description: 'Animal species: Dog, Cat, Horse, Cattle, Swine, etc.' },
      },
      required: ['species'],
    },
  },
  {
    name: 'vet_product_recalls',
    description:
      'Search FDA Enforcement Report recalls for a pet food, animal food, or veterinary drug product or manufacturer. Answers "has Blue Buffalo dog food been recalled", "dog food recalls", "veterinary drug recalls". Source: openFDA food/enforcement.json and drug/enforcement.json — there is no dedicated animal-food recall feed, and coverage of pet-food recalls specifically is uneven (some well-known FDA-confirmed pet-food recalls are not in this dataset at all). A zero-result answer means no FDA Enforcement Report record was found under this name, not that the product was never recalled — check fda.gov/animal-veterinary/safety-health/recalls-withdrawals for the fuller picture the tool states this in its response.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        product: { type: 'string', description: 'Product name, brand, or manufacturer, e.g. "dog food", "Blue Buffalo", "Bravecto".' },
        kind: { type: 'string', description: 'Which FDA enforcement dataset to search: "food" (pet/animal food, default) or "drug" (veterinary drugs).' },
        lot: { type: 'string', description: 'Optional: filter to recalls whose lot/code info mentions this lot number.' },
        limit: { type: 'number', description: 'Max recalls to return (1-50, default 10).' },
      },
      required: ['product'],
    },
  },
  {
    name: 'animal_drug_search',
    description:
      'Search FDA-APPROVED animal drugs — the FDA Green Book (Animal Drugs @ FDA), the official list of approved new animal drug applications. Answers "what FDA-approved drugs contain carprofen", "what drugs are approved for dogs", "what is approved for osteoarthritis in dogs", "what animal drugs does Zoetis market", "which animal drugs have been withdrawn". This is APPROVAL status, not adverse events (see vet_adverse_events) and not recalls (see vet_product_recalls). Pass free text via "query", OR one or more of the structured filters — see the note on "query" for why they do not combine.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Free-text search across the Green Book, e.g. "carprofen", "Rimadyl", "flea". Upstream ignores free text whenever a structured filter is also sent, so when you combine them this tool resolves "query" into active_ingredient (then brand_name) and reports which it used in query_resolved_to. For a precise combined search, pass the structured fields directly instead.' },
        active_ingredient: { type: 'string', description: 'Chemical active ingredient, e.g. "Carprofen", "Meloxicam", "Fluralaner".' },
        species: { type: 'string', description: 'Species the drug is approved for, e.g. "Dogs", "Cats", "Horses", "Cattle". Upstream uses plurals.' },
        sponsor: { type: 'string', description: 'Sponsor/manufacturer, e.g. "Zoetis", "Boehringer Ingelheim", "Merck".' },
        brand_name: { type: 'string', description: 'Proprietary/brand name, e.g. "Rimadyl", "Metacam".' },
        dose_form: { type: 'string', description: 'Dose form, e.g. "Caplet", "Injectable Solution", "Chewable Tablet".' },
        route: { type: 'string', description: 'Route of administration, e.g. "Oral", "Intravenous", "Topical".' },
        indication: { type: 'string', description: 'What the drug is approved to treat, e.g. "osteoarthritis", "postoperative pain", "heartworm".' },
        application_number: { type: 'string', description: 'NADA/ANADA application number, e.g. "141053".' },
        status: { type: 'string', description: 'Approval status: "Approved", "Voluntary Withdrawn", "Granted", "Revoked" (or the raw code A/W/G/R).' },
        limit: { type: 'number', description: 'Rows per page (1-100, default 20).' },
        page: { type: 'number', description: 'Page number, 1-based (default 1).' },
      },
      required: [],
    },
  },
  {
    name: 'animal_drug_detail',
    description:
      'Full FDA Green Book detail for one approved animal drug application, by application_id (from animal_drug_search). Returns the sponsor, every marketed product under the application with its species, dose form, route, strength and approved dosage/indications, plus the FOI approval summaries — FDA\'s own plain-English statement of what each original approval and supplement was FOR, with a PDF link. Answers "what was Rimadyl approved for", "what does application 141053 cover", "show me the approval history of this animal drug".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        application_id: { type: 'number', description: 'Green Book applicationId, e.g. 1024 (Rimadyl Caplets). Get it from animal_drug_search — this is NOT the NADA application number.' },
      },
      required: ['application_id'],
    },
  },
  {
    name: 'animal_drug_monthly_updates',
    description:
      'List the FDA Green Book monthly update publications — the monthly PDF index of what changed in the approved-animal-drug list (new approvals, withdrawals, sponsor/labelling changes). Answers "what animal drug approvals changed recently", "give me the latest Green Book update". Returns year, month and a direct PDF URL per issue.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        year: { type: 'number', description: 'Optional: only this publication year, e.g. 2026.' },
        limit: { type: 'number', description: 'Max issues to return, newest first (1-120, default 12).' },
      },
      required: [],
    },
  },
  {
    name: 'pet_services_near',
    description:
      'Find veterinary clinics, emergency vets, dog parks, pet stores, or animal shelters near a place, via OpenStreetMap. Answers "emergency vet near Austin TX", "dog parks near me", "pet stores in Denver", "animal shelters near Chicago". Pass a place name (city, address, or landmark) — it is geocoded automatically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        place: { type: 'string', description: 'Place name to search near, e.g. "Austin TX", "Portland OR", "downtown Denver".' },
        kind: { type: 'string', description: 'One of: vet, emergency_vet, dog_park, pet_store, shelter. Default vet.' },
        radius_km: { type: 'number', description: 'Search radius in kilometres (1-50, default 10).' },
        limit: { type: 'number', description: 'Max results (1-50, default 20).' },
      },
      required: ['place'],
    },
  },
];

/* ── Shared helpers (openFDA) ─────────────────────────────────────── */

type FdaResponse = {
  meta?: { results?: { skip?: number; limit?: number; total?: number } };
  results?: unknown[];
  error?: { code?: string; message?: string };
};

// api.fda.gov runs on api-umbrella (the api.data.gov stack), so an
// api.data.gov key authenticates it. Threaded through args rather than held
// in module scope because a caller may bring their own and an isolate serves
// requests concurrently — same pattern as mcps/openfda.
function apiKeyOf(args: Record<string, unknown>): string | undefined {
  const key = typeof args._apiKey === 'string' ? args._apiKey.trim() : '';
  return key || undefined;
}

function withApiKey(params: string, apiKey?: string): string {
  return apiKey ? `${params}&api_key=${encodeURIComponent(apiKey)}` : params;
}

async function fdaFetch(endpoint: string, params: string, apiKey?: string): Promise<FdaResponse> {
  let res = await pwFetch(`${BASE}${endpoint}?${withApiKey(params, apiKey)}`);

  // A rejected platform key must never take the pack down — openFDA is
  // usable without one, so fall back to the anonymous quota.
  if (apiKey && res.status === 403) {
    const peek = (await res.clone().text()).slice(0, 500);
    if (peek.includes('API_KEY_INVALID') || peek.includes('API_KEY_MISSING') || peek.includes('API_KEY_DISABLED')) {
      console.warn('veterinary-fda: api key rejected, retrying anonymously');
      res = await pwFetch(`${BASE}${endpoint}?${params}`);
    }
  }

  if (!res.ok) {
    if (res.status === 404) return { results: [], meta: { results: { total: 0, skip: 0, limit: 0 } } };
    const body = (await res.text()).slice(0, 5_000);
    let msg = `openFDA error: ${res.status}`;
    try {
      const err = JSON.parse(body) as FdaResponse;
      if (err.error?.message) msg = `openFDA error (${res.status}): ${err.error.message}`;
    } catch {
      // non-JSON body — the status is still informative
    }
    if (res.status >= 500) msg = `upstream_down: ${msg}`;
    if (res.status === 429) msg = `upstream_throttled: ${msg}`;
    throw new Error(msg);
  }
  return res.json() as Promise<FdaResponse>;
}

function encodeQuery(query: string): string {
  return query.replace(/ /g, '+');
}

/** Bare multi-word values must be phrase-quoted — see the module doc's bare-term trap. */
function termFor(value: string): string {
  const v = value.trim();
  return /\s/.test(v) ? `"${v.replace(/"/g, '')}"` : v;
}

function fieldEq(field: string, value: string): string {
  return `${field}:${termFor(value)}`;
}

function compactDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) throw new Error('since must use YYYY-MM-DD.');
  return `${match[1]}${match[2]}${match[3]}`;
}

function parseFdaDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return raw;
}

/* ── vet_adverse_events / vet_adverse_event_summary ───────────────── */

// drug.brand_name is near-useless upstream (see module doc). Every drug
// lookup searches active_ingredients.name; if a caller passed "drug" (brand
// intent) we also try drug.brand_name first in case some products differ,
// and report which field actually matched.
async function resolveDrugClause(
  args: Record<string, unknown>,
  apiKey: string | undefined,
  baseSearch: string,
): Promise<{ clause: string; resolved_from: 'active_ingredient' | 'brand_name' | 'active_ingredients_field' | null; term: string }> {
  const drug = typeof args.drug === 'string' ? args.drug.trim() : '';
  const activeIngredient = typeof args.active_ingredient === 'string' ? args.active_ingredient.trim() : '';
  const term = activeIngredient || drug;
  if (!term) throw new Error('Pass "drug" (brand/product name) or "active_ingredient" (chemical name).');

  if (activeIngredient) {
    return { clause: fieldEq('drug.active_ingredients.name', activeIngredient), resolved_from: 'active_ingredient', term };
  }

  // "drug" (brand) given: try drug.brand_name first.
  const brandClause = fieldEq('drug.brand_name', drug);
  const brandCheck = await fdaFetch('/animalandveterinary/event.json', `search=${encodeQuery(baseSearch)}+AND+${encodeQuery(brandClause)}&limit=1`, apiKey);
  if ((brandCheck.meta?.results?.total ?? 0) > 0) {
    return { clause: brandClause, resolved_from: 'brand_name', term: drug };
  }

  // Fall back to active_ingredients.name — upstream commonly records the
  // marketed product name there instead of in brand_name.
  return {
    clause: fieldEq('drug.active_ingredients.name', drug),
    resolved_from: 'active_ingredients_field',
    term: drug,
  };
}

function speciesClause(species: string): string {
  const s = species.trim();
  if (!s) throw new Error('species is required, e.g. "Dog", "Cat", "Horse".');
  const titled = s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  return fieldEq('animal.species', titled);
}

function projectEvent(raw: unknown) {
  const r = raw as Record<string, unknown>;
  const animal = (r.animal ?? {}) as Record<string, unknown>;
  const breed = (animal.breed ?? {}) as Record<string, unknown>;
  const age = (animal.age ?? {}) as Record<string, unknown>;
  const weight = (animal.weight ?? {}) as Record<string, unknown>;
  const drugs = (Array.isArray(r.drug) ? r.drug : []) as Array<Record<string, unknown>>;
  const reactions = (Array.isArray(r.reaction) ? r.reaction : []) as Array<Record<string, unknown>>;
  const outcomes = (Array.isArray(r.outcome) ? r.outcome : []) as Array<Record<string, unknown>>;
  return {
    report_id: r.report_id ?? r.unique_aer_id_number ?? null,
    original_receive_date: parseFdaDate(r.original_receive_date),
    animal: {
      species: animal.species ?? null,
      gender: animal.gender ?? null,
      breed: breed.breed_component ?? null,
      is_crossbred: breed.is_crossbred ?? null,
      age: age.min ? `${age.min} ${age.unit ?? ''}`.trim() : null,
      weight: weight.min ? `${weight.min} ${weight.unit ?? ''}`.trim() : null,
    },
    reactions: reactions.map((rx) => ({ term: rx.veddra_term_name ?? null, animals_affected: rx.number_of_animals_affected ?? null })),
    outcomes: outcomes.map((o) => ({ status: o.medical_status ?? null, animals_affected: o.number_of_animals_affected ?? null })),
    drugs: drugs.map((d) => ({
      brand_name: d.brand_name ?? null,
      active_ingredients: (Array.isArray(d.active_ingredients) ? d.active_ingredients : [])
        .map((ai) => (ai as Record<string, unknown>).name)
        .filter(Boolean),
      route: d.route ?? null,
      dose: d.dose ?? null,
      used_according_to_label: d.used_according_to_label ?? null,
    })),
    serious_ae: r.serious_ae ?? null,
    treated_for_ae: r.treated_for_ae ?? null,
  };
}

async function vetAdverseEvents(args: Record<string, unknown>): Promise<unknown> {
  const apiKey = apiKeyOf(args);
  const species = typeof args.species === 'string' ? args.species : '';
  const baseSearch = speciesClause(species);
  const { clause: drugClause, resolved_from, term } = await resolveDrugClause(args, apiKey, encodeQuery(baseSearch));

  const parts = [baseSearch, drugClause];
  if (typeof args.reaction === 'string' && args.reaction.trim()) {
    parts.push(fieldEq('reaction.veddra_term_name', args.reaction.trim()));
  }
  if (typeof args.breed === 'string' && args.breed.trim()) {
    parts.push(fieldEq('animal.breed.breed_component', args.breed.trim()));
  }
  if (typeof args.since === 'string' && args.since.trim()) {
    parts.push(`original_receive_date:[${compactDate(args.since)}+TO+${new Date().toISOString().slice(0, 10).replace(/-/g, '')}]`);
  }
  const search = parts.join('+AND+');
  const limit = Math.min(50, Math.max(1, (args.limit as number) ?? 10));

  const data = await fdaFetch('/animalandveterinary/event.json', `search=${encodeQuery(search)}&limit=${limit}`, apiKey);
  return {
    species,
    resolved_from,
    resolved_term: term,
    total: data.meta?.results?.total ?? 0,
    events: (data.results ?? []).map(projectEvent),
    note: resolved_from === 'active_ingredients_field'
      ? `"${term}" did not match drug.brand_name upstream (that field is unreliable — it usually holds the registrant's short code, not the product name); matched instead against the active-ingredients field, where openFDA records the marketed product name.`
      : undefined,
  };
}

async function vetAdverseEventSummary(args: Record<string, unknown>): Promise<unknown> {
  const apiKey = apiKeyOf(args);
  const species = typeof args.species === 'string' ? args.species : '';
  const baseSearch = speciesClause(species);
  const { clause: drugClause, resolved_from, term } = await resolveDrugClause(args, apiKey, encodeQuery(baseSearch));
  const search = `${baseSearch}+AND+${drugClause}`;
  const encSearch = encodeQuery(search);

  const [byReaction, byOutcome, byDate] = await Promise.all([
    fdaFetch('/animalandveterinary/event.json', `search=${encSearch}&count=reaction.veddra_term_name.exact`, apiKey),
    fdaFetch('/animalandveterinary/event.json', `search=${encSearch}&count=outcome.medical_status.exact`, apiKey),
    // count=original_receive_date.exact returns "Nothing to count" — the
    // .exact suffix is per-field and this date field doesn't support it.
    // The plain field returns one bucket per distinct DAY, so years are
    // aggregated client-side below.
    fdaFetch('/animalandveterinary/event.json', `search=${encSearch}&count=original_receive_date`, apiKey),
  ]);

  const byYear = new Map<string, number>();
  for (const row of (byDate.results ?? []) as Array<{ time?: string; count?: number }>) {
    const year = row.time?.slice(0, 4);
    if (!year) continue;
    byYear.set(year, (byYear.get(year) ?? 0) + (row.count ?? 0));
  }

  const totalCheck = await fdaFetch('/animalandveterinary/event.json', `search=${encSearch}&limit=1`, apiKey);

  return {
    species,
    resolved_from,
    resolved_term: term,
    total: totalCheck.meta?.results?.total ?? 0,
    by_reaction: ((byReaction.results ?? []) as Array<{ term?: string; count?: number }>).slice(0, 20),
    by_outcome: (byOutcome.results ?? []) as Array<{ term?: string; count?: number }>,
    by_year: Array.from(byYear.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([year, count]) => ({ year, count })),
    note: resolved_from === 'active_ingredients_field'
      ? `"${term}" did not match drug.brand_name upstream; matched instead against the active-ingredients field.`
      : undefined,
  };
}

/* ── vet_product_recalls ──────────────────────────────────────────── */

function projectRecall(raw: unknown) {
  const r = raw as Record<string, unknown>;
  return {
    recall_number: r.recall_number ?? null,
    status: r.status ?? null,
    classification: r.classification ?? null,
    recalling_firm: r.recalling_firm ?? null,
    product_description: r.product_description ?? null,
    reason_for_recall: r.reason_for_recall ?? null,
    distribution_pattern: r.distribution_pattern ?? null,
    recall_initiation_date: parseFdaDate(r.recall_initiation_date),
    report_date: parseFdaDate(r.report_date),
    code_info: r.code_info ?? null,
    voluntary_mandated: r.voluntary_mandated ?? null,
    state: r.state ?? null,
    country: r.country ?? null,
  };
}

const NO_RECALL_NOTE =
  'No matching FDA Enforcement Report record. openFDA has no dedicated animal/pet-food recall feed and coverage of pet-food recalls specifically is uneven — some FDA-confirmed pet-food recalls (e.g. several Blue Buffalo recalls, the 2021 Sportmix aflatoxin recall) are not in this dataset under any product/firm name tried. A zero here means "no Enforcement Report record found", not "never recalled" — check https://www.fda.gov/animal-veterinary/safety-health/recalls-withdrawals for FDA\'s fuller recall history.';

async function vetProductRecalls(args: Record<string, unknown>): Promise<unknown> {
  const apiKey = apiKeyOf(args);
  const product = typeof args.product === 'string' ? args.product.trim() : '';
  if (!product) throw new Error('product is required, e.g. "dog food", "Blue Buffalo".');
  const kind = args.kind === 'drug' ? 'drug' : 'food';
  const endpoint = kind === 'drug' ? '/drug/enforcement.json' : '/food/enforcement.json';
  const limit = Math.min(50, Math.max(1, (args.limit as number) ?? 10));

  // Deliberately phrase-quoted only, no loose bare-term fallback — see the
  // module doc: a false-positive recall match is worse than an honest zero.
  const productTerm = termFor(product);
  const search = `(product_description:${productTerm}+OR+recalling_firm:${productTerm})`;
  const params = [`search=${encodeQuery(search)}`, `limit=${limit}`];
  if (typeof args.lot === 'string' && args.lot.trim()) {
    params.push(`search=${encodeQuery(fieldEq('code_info', args.lot.trim()))}`);
  }

  const data = await fdaFetch(endpoint, params.join('&'), apiKey);
  const total = data.meta?.results?.total ?? 0;
  return {
    product,
    kind,
    total,
    recalls: (data.results ?? []).map(projectRecall),
    ...(total === 0 ? { note: NO_RECALL_NOTE } : {}),
  };
}

/* ── pet_services_near (OpenStreetMap / Overpass) ─────────────────── */
// Same approach as mcps/overpass's pois_near: geocode via Nominatim, then an
// Overpass QL "around" query. Kept self-contained here (rather than
// importing mcps/overpass) because published packs are inlined standalone
// and pack-to-pack imports aren't shared at publish time.

const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

// Overpass and Nominatim both refuse Cloudflare Worker egress (429, then 521)
// while answering 200 from anywhere else, so they are relayed through the
// egress proxy when the gateway injects one. Measured on the relay before
// wiring, per the GLOBOCAN/#1070 rule in egress-proxy: 406 with no User-Agent,
// 200 with one — so the hop works AND the UA is load-bearing through it.
// Same wiring as mcps/overpass; duplicated rather than imported for the reason
// given above (published packs are inlined standalone). Fleet #1246.
let PROXY: { url: string; token: string } | null = null;

async function relay(
  target: string,
  init: { method?: string; body?: string; contentType?: string },
): Promise<Response | null> {
  if (!PROXY) return null;
  return pwFetch(PROXY.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PROXY.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: target,
      method: init.method ?? 'GET',
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.contentType ? { contentType: init.contentType } : {}),
      userAgent: OVERPASS_UA,
    }),
  });
}
const OVERPASS_UA = 'Pipeworx-VeterinaryFDA-MCP/0.1 (contact@mojibake.ai)';

const KIND_TAGS: Record<string, string> = {
  vet: '["amenity"="veterinary"]',
  emergency_vet: '["amenity"="veterinary"]["emergency"="yes"]',
  dog_park: '["leisure"="dog_park"]',
  pet_store: '["shop"="pet"]',
  shelter: '["amenity"="animal_shelter"]',
};

async function geocodePlace(place: string): Promise<{ lat: number; lon: number; display: string }> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(place)}`;
  const res = (await relay(url, { method: 'GET' })) ?? (await pwFetch(url, { headers: { 'User-Agent': OVERPASS_UA, 'Accept-Language': 'en' } }));
  if (!res.ok) throw new Error(`Geocoding "${place}" failed (Nominatim HTTP ${res.status}).`);
  const rows = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
  if (!rows.length) throw new Error(`Could not geocode "${place}" — try a more specific place name.`);
  return { lat: Number(rows[0].lat), lon: Number(rows[0].lon), display: rows[0].display_name };
}

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

async function overpassPost(qql: string): Promise<{ elements?: OverpassElement[] }> {
  const body = `data=${encodeURIComponent(qql)}`;
  const res = (await relay(OVERPASS_ENDPOINT, {
    method: 'POST',
    body,
    contentType: 'application/x-www-form-urlencoded',
  })) ?? (await pwFetch(OVERPASS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': OVERPASS_UA },
    body,
  }));
  if (res.status === 429) throw new Error('Overpass: rate-limited (HTTP 429). Try again shortly.');
  if (res.status === 504) throw new Error('Overpass: query timed out (HTTP 504). Try a smaller radius.');
  if (!res.ok) throw await httpError(res, 'OpenStreetMap Overpass');
  return res.json() as Promise<{ elements?: OverpassElement[] }>;
}

function normalizeElement(el: OverpassElement) {
  const tags = el.tags ?? {};
  return {
    name: tags.name ?? null,
    latitude: el.lat ?? el.center?.lat ?? null,
    longitude: el.lon ?? el.center?.lon ?? null,
    phone: tags.phone ?? tags['contact:phone'] ?? null,
    website: tags.website ?? tags['contact:website'] ?? null,
    opening_hours: tags.opening_hours ?? null,
    address: [tags['addr:housenumber'], tags['addr:street'], tags['addr:city'], tags['addr:state']].filter(Boolean).join(' '),
    emergency: tags.emergency ?? null,
    osm_url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    tags,
  };
}

async function petServicesNear(args: Record<string, unknown>): Promise<unknown> {
  const place = typeof args.place === 'string' ? args.place.trim() : '';
  if (!place) throw new Error('place is required, e.g. "Austin TX".');
  const kind = typeof args.kind === 'string' && KIND_TAGS[args.kind] ? args.kind : 'vet';
  const radiusM = Math.min(50_000, Math.max(1_000, ((args.radius_km as number) ?? 10) * 1000));
  const limit = Math.min(50, Math.max(1, (args.limit as number) ?? 20));

  const geo = await geocodePlace(place);
  const filter = KIND_TAGS[kind];
  const runQuery = async (f: string) => {
    const qql = `[out:json][timeout:25];
(
  node${f}(around:${radiusM},${geo.lat},${geo.lon});
  way${f}(around:${radiusM},${geo.lat},${geo.lon});
);
out center ${limit};`;
    return overpassPost(qql);
  };

  let data = await runQuery(filter);
  let fellBackToAllVets = false;
  // emergency=yes is under-tagged in OSM: many ER vets simply aren't marked
  // that way. Rather than a false "no emergency vets found" for a place that
  // has vet clinics, fall back to all veterinary clinics near the point and
  // say so, so the caller can call ahead rather than getting a dead end.
  if (kind === 'emergency_vet' && (data.elements?.length ?? 0) === 0) {
    data = await runQuery(KIND_TAGS.vet);
    fellBackToAllVets = true;
  }

  return {
    place,
    geocoded_from: geo.display,
    center: { latitude: geo.lat, longitude: geo.lon },
    kind,
    radius_km: radiusM / 1000,
    count: data.elements?.length ?? 0,
    results: (data.elements ?? []).map(normalizeElement),
    ...(fellBackToAllVets ? {
      note: 'No OSM points tagged emergency=yes within radius; showing nearby veterinary clinics instead — call ahead to confirm after-hours/emergency service.',
    } : {}),
  };
}

/* ── FDA Green Book (Animal Drugs @ FDA) ──────────────────────────── */

// A DIFFERENT upstream from the openFDA calls above: the Green Book SPA's own
// backing API. Public, keyless, JSON; no api.data.gov key applies to it.
const GREENBOOK = 'https://animaldrugsatfda.fda.gov/adafda/app/search/public';

// Document downloads. All three verified 200 application/pdf 2026-09-05
// (downloadFoi/586 = 113KB, downloadLabeling/403 = 526KB,
// downloadMonthlyUpdate/2202 = 159KB). The monthly-update path is NOT under
// /document/ like the other two — it hangs off /monthlyUpdates/ instead.
const FOI_PDF = `${GREENBOOK}/document/downloadFoi`;
const LABELING_PDF = `${GREENBOOK}/document/downloadLabeling`;
const MONTHLY_PDF = `${GREENBOOK}/monthlyUpdates/downloadMonthlyUpdate`;

type GreenbookPage = {
  content?: unknown[];
  totalElements?: number;
  numberOfElements?: number;
};

async function greenbookFetch(path: string, body?: unknown): Promise<unknown> {
  const init: RequestInit = body === undefined
    ? {}
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await pwFetch(`${GREENBOOK}${path}`, init);
  if (!res.ok) {
    const detail = await httpErrorMessage(res, 'FDA Green Book');
    if (res.status >= 500) throw new Error(`upstream_down: ${detail}`);
    if (res.status === 429) throw new Error(`upstream_throttled: ${detail}`);
    throw new Error(detail);
  }
  return res.json();
}

// The /codes lookups are tiny and effectively static, so they are memoised per
// isolate. A failed fetch clears the memo (so the next call retries) and falls
// back to the table below — a status must never surface as a bare letter, and
// degrading the whole tool because a 4-row lookup blipped would be worse.
const STATUS_FALLBACK: Record<string, string> = {
  A: 'Approved', W: 'Voluntary Withdrawn', G: 'Granted', R: 'Revoked',
};
const TYPE_FALLBACK: Record<string, string> = {
  N: 'NADA (New Animal Drug Application)',
  A: 'ANADA (Abbreviated New Animal Drug Application)',
  C: 'CNADA (Conditional New Animal Drug Application)',
  E: 'EUA (Emergency Use Authorization)',
};

let codeCache: Map<string, Promise<Record<string, string>>> | undefined;

async function codeMap(name: 'application_status' | 'application_type'): Promise<Record<string, string>> {
  if (!codeCache) codeCache = new Map();
  const hit = codeCache.get(name);
  if (hit) return hit;
  const pending = (async () => {
    const rows = (await greenbookFetch(`/codes/${name}`)) as Array<Record<string, unknown>>;
    const out: Record<string, string> = {};
    for (const row of Array.isArray(rows) ? rows : []) {
      const code = typeof row.code === 'string' ? row.code : null;
      const value = typeof row.value === 'string' ? row.value : null;
      if (code && value) out[code] = value;
    }
    if (!Object.keys(out).length) throw new Error('empty code list');
    return out;
  })().catch((err) => {
    codeCache?.delete(name);
    console.warn(`veterinary-fda: /codes/${name} lookup failed, using fallback table: ${String(err)}`);
    return name === 'application_status' ? STATUS_FALLBACK : TYPE_FALLBACK;
  });
  codeCache.set(name, pending);
  return pending;
}

/** publishDate / voluntaryWithdrawalDate are epoch MILLISECONDS, not seconds. */
function epochMsToDate(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** proprietaryName can carry embedded newlines: "Carprofen Caplets\nNovox® Caplets". */
function splitNames(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

async function projectApplicationRow(raw: unknown) {
  const r = raw as Record<string, unknown>;
  const [statuses, types] = await Promise.all([codeMap('application_status'), codeMap('application_type')]);
  const statusCode = typeof r.applicationStatusCode === 'string' ? r.applicationStatusCode : null;
  const typeCode = typeof r.applicationType === 'string' ? r.applicationType : null;
  const names = splitNames(r.proprietaryName);
  return {
    application_id: r.applicationId ?? null,
    application_number: r.applicationNumber ?? null,
    // applicationStatusValue is ALWAYS null in list rows — decoded here, never
    // passed through raw, or every result reads as status-unknown.
    status: statusCode ? statuses[statusCode] ?? `Unknown code ${statusCode}` : null,
    status_code: statusCode,
    application_type: typeCode ? types[typeCode] ?? `Unknown code ${typeCode}` : null,
    application_type_code: typeCode,
    proprietary_name: names[0] ?? null,
    // A single row can market several names; the extra ones are only visible
    // if you split, so both shapes are returned.
    proprietary_names: names,
    active_ingredient: r.activeIngredientName ?? null,
    sponsor: r.sponsorName ?? null,
    publish_date: epochMsToDate(r.publishDate),
    voluntary_withdrawal_date: epochMsToDate(r.voluntaryWithdrawalDate),
  };
}

const ADVANCED_FIELDS: Array<[string, string]> = [
  ['active_ingredient', 'activeIngredientName'],
  ['species', 'speciesName'],
  ['sponsor', 'sponsorName'],
  ['brand_name', 'proprietaryName'],
  ['dose_form', 'doseFormName'],
  ['route', 'routeName'],
  ['indication', 'indication'],
  ['application_number', 'applicationNumber'],
];

function statusCodeFor(value: string): string {
  const v = value.trim();
  if (/^[AWGR]$/i.test(v)) return v.toUpperCase();
  const found = Object.entries(STATUS_FALLBACK).find(([, label]) => label.toLowerCase() === v.toLowerCase());
  if (found) return found[0];
  if (/^withdraw/i.test(v)) return 'W';
  throw new Error(`Unrecognised status "${value}". Use Approved, Voluntary Withdrawn, Granted or Revoked.`);
}

async function greenbookSearch(body: Record<string, unknown>, advanced: boolean): Promise<GreenbookPage> {
  const path = advanced ? '/advancedSearch' : '/basicSearch';
  return (await greenbookFetch(path, body)) as GreenbookPage;
}

async function animalDrugSearch(args: Record<string, unknown>) {
  const limit = clampInt(args.limit, 1, 100, 20);
  const page = clampInt(args.page, 1, 10_000, 1);
  const query = typeof args.query === 'string' ? args.query.trim() : '';

  const filters: Record<string, unknown> = {};
  for (const [arg, field] of ADVANCED_FIELDS) {
    const v = args[arg];
    if (typeof v === 'string' && v.trim()) filters[field] = v.trim();
    else if (typeof v === 'number') filters[field] = String(v);
  }
  if (typeof args.status === 'string' && args.status.trim()) {
    filters.applicationStatusCode = statusCodeFor(args.status);
  }

  const hasFilters = Object.keys(filters).length > 0;
  if (!query && !hasFilters) {
    throw new Error('Pass "query" (free text) or at least one filter (active_ingredient, species, sponsor, brand_name, dose_form, route, indication, application_number, status).');
  }

  const paging = {
    isExact: false,
    sortField: 'applicationNumber',
    sortDirection: 'false',
    pageSize: limit,
    pageNumber: page,
  };

  let queryResolvedTo: string | null = null;
  let result: GreenbookPage;

  if (query && !hasFilters) {
    result = await greenbookSearch({ basicSearchTerm: query, ...paging }, false);
  } else if (!query) {
    result = await greenbookSearch({ basicSearchTerm: null, ...filters, ...paging }, true);
  } else {
    // TRAP: /advancedSearch silently DROPS basicSearchTerm. Measured 2026-09-05:
    // {basicSearchTerm:"carprofen", speciesName:"Cats"} returned 338 rows — the
    // whole Cats set, led by Pentobarbital Sodium — not the carprofen∩cats
    // intersection. It is a 200 with confidently wrong rows, so free text is
    // resolved into a real field instead of being passed through.
    result = await greenbookSearch({ basicSearchTerm: null, activeIngredientName: query, ...filters, ...paging }, true);
    queryResolvedTo = 'active_ingredient';
    if (!(result.totalElements ?? 0)) {
      result = await greenbookSearch({ basicSearchTerm: null, proprietaryName: query, ...filters, ...paging }, true);
      queryResolvedTo = 'brand_name';
    }
  }

  const rows = Array.isArray(result.content) ? result.content : [];
  const total = result.totalElements ?? 0;
  const drugs = await Promise.all(rows.map(projectApplicationRow));

  return {
    source: 'FDA Green Book (Animal Drugs @ FDA) — approved new animal drug applications',
    source_url: 'https://animaldrugsatfda.fda.gov/adafda/views/#/search',
    search: query && !hasFilters ? { mode: 'free_text', query } : { mode: 'filtered', query: query || null, query_resolved_to: queryResolvedTo, filters },
    total_matching: total,
    // Upstream's own totalPages is ALWAYS 1 regardless of the real count
    // (694 dog rows at pageSize 2 still reports totalPages 1), so it is
    // recomputed here — trusting it silently truncates every large result.
    page,
    page_size: limit,
    total_pages: Math.max(1, Math.ceil(total / limit)),
    has_more: page * limit < total,
    returned: drugs.length,
    drugs,
    ...(drugs.length === 0
      ? { note: 'No approved animal drug applications matched. The Green Book covers FDA-approved animal drugs only — an unapproved, compounded, or human-label drug used off-label in animals will not appear here.' }
      : {}),
    ...(queryResolvedTo
      ? { note: `Free text and structured filters cannot be combined upstream, so "query" was searched as ${queryResolvedTo}. Pass the structured field directly to control this.` }
      : {}),
  };
}

async function animalDrugDetail(args: Record<string, unknown>) {
  const id = clampInt(args.application_id, 1, Number.MAX_SAFE_INTEGER, 0);
  if (!id) throw new Error('application_id is required — the numeric Green Book applicationId from animal_drug_search.');

  // retrievePreviewBean carries the rich content but returns its `application`
  // block almost entirely null (applicationNumber 0, type/status null), so the
  // identity fields come from /preview/{id} instead. Neither alone is enough.
  //
  // /preview is also the id check, and has to run FIRST rather than in parallel:
  // retrievePreviewBean answers an unknown id with a 500 and an HTML Weblogic
  // error page, which would otherwise surface as `upstream_down` — reporting
  // FDA as down when the real fault is a bad argument. /preview answers the
  // same id with a clean 200 and applicationId null.
  const head = ((await greenbookFetch(`/preview/${id}`)) ?? {}) as Record<string, unknown>;
  if (head.applicationId === null || head.applicationId === undefined) {
    throw new Error(`No FDA Green Book application with application_id ${id}. That argument is the Green Book applicationId from animal_drug_search (e.g. 1024 for Rimadyl Caplets), NOT the NADA/ANADA application number (e.g. 141053).`);
  }

  const detail = await greenbookFetch(`/retrievePreviewBean/${id}`);
  const d = (detail ?? {}) as Record<string, unknown>;
  const documents = (d.documents ?? {}) as Record<string, unknown>;
  const [statuses, types] = await Promise.all([codeMap('application_status'), codeMap('application_type')]);

  const statusCode = typeof head.applicationStatusCode === 'string' ? head.applicationStatusCode : null;
  const typeCode = typeof head.applicationType === 'string' ? head.applicationType : null;

  const foi = (Array.isArray(documents.foi) ? documents.foi : []) as Array<Record<string, unknown>>;
  const labeling = (Array.isArray(documents.labeling) ? documents.labeling : []) as Array<Record<string, unknown>>;
  const products = (Array.isArray(d.proprietaryPreviewBean) ? d.proprietaryPreviewBean : []) as Array<Record<string, unknown>>;

  return {
    source: 'FDA Green Book (Animal Drugs @ FDA)',
    source_url: `https://animaldrugsatfda.fda.gov/adafda/views/#/preview/${id}`,
    application_id: id,
    application_number: head.applicationNumber ?? null,
    application_type: typeCode ? types[typeCode] ?? `Unknown code ${typeCode}` : null,
    status: statusCode ? statuses[statusCode] ?? `Unknown code ${statusCode}` : null,
    products: products.map((p) => ({
      proprietary_names: splitNames(p.proprietaryName),
      dose_form: p.doseFormName ?? null,
      marketing_status: p.statusDescription ?? null,
      routes: Array.isArray(p.routes) ? p.routes : [],
      // `species` is an object keyed "Dogs:43" -> use class; the label after
      // the colon is the use class, not a second species.
      species: p.species && typeof p.species === 'object' ? Object.keys(p.species as object).map((k) => k.split(':')[0]) : [],
      species_use_classes: p.species && typeof p.species === 'object' ? (p.species as Record<string, string>) : {},
      specifications: p.specifications ?? null,
      dosage_and_indications: (Array.isArray(p.ailHeader) ? p.ailHeader : []).map((h) => {
        const hh = h as Record<string, unknown>;
        return {
          species: hh.ailHeader ?? null,
          entries: (Array.isArray(hh.ails) ? hh.ails : []).map((a) => {
            const aa = a as Record<string, unknown>;
            return { dosage: aa.dosageAmount ?? null, indication: aa.indication ?? aa.indications ?? null };
          }),
        };
      }),
    })),
    // The reason this pack has a detail tool at all: FDA's own plain-English
    // statement of what each approval and supplement was FOR.
    approval_summaries: foi.map((f) => ({
      approval_type: f.approvalType ?? null,
      approval_date: f.approvalDate ?? null,
      summary: f.summary ?? null,
      pdf_url: f.foiId ? `${FOI_PDF}/${f.foiId}` : null,
    })),
    labeling_documents: labeling.map((l) => ({
      component: l.labelingComponent ?? null,
      proprietary_name: l.proprietaryName ?? null,
      pdf_url: l.labelingId ? `${LABELING_PDF}/${l.labelingId}` : null,
    })),
    ...(products.length === 0 && foi.length === 0
      ? { note: `No detail rows for application_id ${id}. Confirm the id came from animal_drug_search — it is the Green Book applicationId, not the NADA/ANADA application number.` }
      : {}),
  };
}

async function animalDrugMonthlyUpdates(args: Record<string, unknown>) {
  const limit = clampInt(args.limit, 1, 120, 12);
  const wantYear = typeof args.year === 'number' ? args.year : undefined;

  const years = (await greenbookFetch('/monthlyUpdates')) as Array<Record<string, unknown>>;
  const issues: Array<{ year: number; month: number; file_name: string | null; pdf_url: string | null }> = [];

  for (const y of Array.isArray(years) ? years : []) {
    const year = typeof y.year === 'number' ? y.year : null;
    if (year === null) continue;
    if (wantYear !== undefined && year !== wantYear) continue;
    const list = (Array.isArray(y.monthlyUpdatesDTO) ? y.monthlyUpdatesDTO : []) as Array<Record<string, unknown>>;
    for (const m of list) {
      if (m.visibleFlag === 'N') continue;
      const gmuId = typeof m.greenbookMonthlyUpdatesId === 'number' ? m.greenbookMonthlyUpdatesId : null;
      issues.push({
        year: typeof m.gmuYear === 'number' ? m.gmuYear : year,
        month: typeof m.gmuMonth === 'number' ? m.gmuMonth : 0,
        file_name: typeof m.gmuFileName === 'string' ? m.gmuFileName : null,
        pdf_url: gmuId ? `${MONTHLY_PDF}/${gmuId}` : null,
      });
    }
  }

  issues.sort((a, b) => (b.year - a.year) || (b.month - a.month));
  const page = issues.slice(0, limit);

  return {
    source: 'FDA Green Book monthly updates (Animal Drugs @ FDA)',
    source_url: 'https://animaldrugsatfda.fda.gov/adafda/views/#/monthlyUpdates',
    ...(wantYear !== undefined ? { year: wantYear } : {}),
    total_issues: issues.length,
    returned: page.length,
    issues: page,
    ...(page.length === 0
      ? { note: wantYear !== undefined ? `No Green Book monthly updates published for ${wantYear}.` : 'No Green Book monthly updates returned upstream.' }
      : { note: 'Each issue is a PDF listing that month\'s changes to the approved-animal-drug list. pdf_url is a direct download.' }),
  };
}

/* ── callTool dispatcher ──────────────────────────────────────────── */

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  // Gateway-injected relay credentials, captured then DELETED so they can never
  // be echoed back to a caller or read as a query argument.
  PROXY =
    typeof args._proxyUrl === 'string' && typeof args._proxyToken === 'string'
      ? { url: args._proxyUrl, token: args._proxyToken }
      : null;
  delete args._proxyUrl;
  delete args._proxyToken;

  switch (name) {
    case 'vet_adverse_events':
      return vetAdverseEvents(args);
    case 'vet_adverse_event_summary':
      return vetAdverseEventSummary(args);
    case 'vet_product_recalls':
      return vetProductRecalls(args);
    case 'pet_services_near':
      return petServicesNear(args);
    case 'animal_drug_search':
      return animalDrugSearch(args);
    case 'animal_drug_detail':
      return animalDrugDetail(args);
    case 'animal_drug_monthly_updates':
      return animalDrugMonthlyUpdates(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 3 } } satisfies McpToolExport;
