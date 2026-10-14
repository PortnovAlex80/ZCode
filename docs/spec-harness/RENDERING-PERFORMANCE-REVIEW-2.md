# Independent review #2 of the rendering-performance candidate

Date: 2026-10-14. Reviewed checkpoint: `D:\Development\ZCode-Harness-render-perf`
`2e52f34197dc8581b5f7c5eba1e7cb46462e60fb`; integrated window/layout target `25d13f67`.
Review instructions: preserve newer work including any uncommitted benchmark; do not
reset to the reviewed checkpoint or overwrite active workers; the main checkout stays
read-only; no merge into dev/master; finish with a reviewed candidate and wait for the
user's separate merge instruction. Findings:

## 1. FIX REAL TIMELINE CACHE INVALIDATION — HIGH PRIORITY

ConversationTimeline.tsx:550–568 recreates plugin derivation and its resolver whenever
rows change. conversationTurnRenderUnitsCache.ts:126–148 then invalidates every
resolver-sensitive completed turn. draftHasToolCallRows treats ordinary tool calls as
sensitive too.

Reproduction: generateV4ReplayRows({ turns: 200, seed: 20261012 }); run the actual
deriveLogicalUiInstances -> resolver -> cached builder chain; replace only one
assistantText row; repeat with the resolver lifecycle used by Timeline. Observed:
200 turns materialized again; zero unchanged output-unit identities retained; no plugin
cards needed to trigger this.

Make invalidation depend on relevant semantic plugin changes, rather than incidental
resolver identity. Preserve manual disclosure, resource supersession and recent-turn
auto-expansion, including effects on older turns. Do not fix by blindly ignoring
resolver dependencies. Add an integration-level work-count/identity regression using
real plugin derivation and resolver updates. Existing cache tests with absent or
constant resolvers do not cover production wiring.

## 2. FIX INACTIVE DISCUSSION VISIBILITY IN PiP — HIGH PRIORITY

SpecDocumentPane.tsx:1320 uses `discussionPopout.popped || (visible &&
discussionsVisible && thread.id === activeThreadId)`. When popped, ALL retained threads
receive visible=true although inactive wrappers still use className="hidden". Affects
presentation, telemetry, interactionDialogsVisible and native preparation.
useSpecDiscussion.ts:192–221 can create sessions for hidden unsent discussions.

Keep active-thread identity outside the placement OR. Derive visibility from the actual
displayed host and selected thread. Test at least two retained threads, including an
unsent draft: only the active thread may become presented or eligible for visible-only
preparation/dialogs. Cover popout, switching threads, return and host-document
visibility.

## 3. APPLY OWNER-DOCUMENT VISIBILITY TO SESSIONPANE

SessionPane.tsx:713–718 and :1187–1198 gate presentation with the raw
presentationVisible prop. ConversationTimeline combines that prop with actual
host-document visibility, SessionPane does not. Hiding the main/PiP document still
rebuilds the parent's workflow maps and can call notifyUserInputRendered while the
timeline deliberately retains older displayed rows.

Use consistent owner-document-aware visibility for presentation responsibilities.
Preserve projection subscriptions, permissions, lifecycle, execution configuration,
required background aggregation and plugin live events. Test actual SessionPane
behavior, not only a generic visibility-hook probe: visible host; hidden main document;
visible PiP while main hidden; hidden PiP; reveal with accumulated projection updates.

## 4. REMOVE REMAINING HIDDEN TOKEN-FREQUENCY PRESENTATION SCANS

- SessionPane.tsx:1178–1180 calls hasPluginReferenceUserRows directly every render; a
  frozen array reference does not memoize its scan.
- :893–902 builds a Map of the entire live row window for
  eligibleShareProductTurnIds even when sharing is inactive and eligibleShareItems is
  empty.
- :774–779 continues full share render-unit rebuilding while share mode is active and
  the pane becomes hidden.

Preserve sharing selections/drafts and required control work. Add deterministic
counters for hidden streaming with sharing both inactive and active. Verify these
actual derivations, not only the main Timeline builder.

## 5. PRESERVE FINAL HIGHSPEED OUTPUT IDENTITY

conversationTurnRenderUnitsCache.ts calls markHighspeedOutputFooterUnits on every
build; highspeedOutputFooter.ts:40–47 clones every marked output each time.
Reproduction: four completed turns each with a distinct expired card; identical
rows/options on two builds → second-build materializations: 0; unchanged output
identities: 0. Preserve final output identity when content and footer metadata are
unchanged. Retain expiry and cross-turn footer movement semantics. Remove the test
exemption that excludes marked units from unchanged-identity assertions.

## 6. COMPLETE HIDDEN GEOMETRY AND REVEAL COVERAGE

Timeline's width/height observer and synchronous measurement path remain active while
hidden; header/mask/live-tail observers also need review. The layout effect now depends
on presented without a corresponding hidden guard. Add fake ResizeObserver and
geometry-call counters covering hidden resizing, streaming, manual reading anchors,
bottom following and reveal. Existing tests with an empty mocked virtualizer do not
establish this boundary. Do not remove flushSync or redesign resize behavior without
the required renderer evidence. Suspend unnecessary hidden presentation measurements
while preserving correct reveal remeasurement. Also test hide -> Highspeed expiry ->
reveal with IDENTICAL rows/config: the render-unit memo does not depend on presented,
so its claimed fresh-clock reveal commit is not guaranteed — resolve missed expiry at
the defined reveal boundary without adding history-wide periodic work.

## 7. CLOSE BATCH ORACLE EDGE CASES

applyFrame.ts:168–171 assembles workflowRuns before other newly introduced state keys,
violating its explicit JSON.stringify equality contract. Valid reproduction when both
keys are initially absent:
[{ op: "state.updated", patch: { workspaceHookAdmission: null } },
 { op: "state.updated", patch: { workflowRuns: { revision: 1, runs: [] } } }]
Deep values match, but serialized property order differs from applyConversationDeltas.
Also an explicitly present `workflowRuns: undefined` is discarded by the !== undefined
check followed by deletion from the overlay; the public schema/type permits this — the
reference clears the value while the candidate retains it (public pure-API edge).
Preserve the unchanged oracle and add these cases. Extend retained/frozen-input
coverage to nested toolCall.output across consecutive output.text updates.

## 8. COMPLETE EVIDENCE BEFORE HANDOFF

The reviewed committed diff contains no performance-spec/checklist updates or new
candidate benchmark; new benchmark work appeared during review and was not evaluated —
preserve and review it. Update the relevant specification before repairs and record
P-item evidence. Complete paired measurements using: actual Timeline
plugin/resolver/cache preparation; final Highspeed-marked outputs; helper-only and full
store boundaries; single-op and realistic post-coalescing mixed frames; small windows
and 200/1000/2000 hydrated turns; cold preparation, cumulative streaming and
hidden/reveal work counts. Include allocation/index costs, repeated paired trials,
p50/p95 and actual loaded rows. Keep pure-function, isolated React and production
evidence separate.

## Review baseline facts

All 40 tests in the seven added suites passed during review, as did 120 existing
regression tests across six additional suites. Typecheck and architecture passed; lint
63 warnings / 0 errors. These results do not cover the failures above. Assign fixes to
the existing exclusive owners; review stable repaired diffs independently; rerun
affected tests and required integration checks; invalidate affected measurements after
repairs. Report the candidate SHA, integrated window target, findings resolved, actual
evidence and remaining live gates. Do not claim production acceptance, launch the
application or merge into the common branch.
