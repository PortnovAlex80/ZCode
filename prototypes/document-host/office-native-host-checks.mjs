// In-page acceptance scripts for the isolated Office fixture. They run inside the
// pane WebView of a disposable Word/Excel document created and owned by
// Test-Office-Adapters.ps1, drive the adapter through the real application API and
// never touch a document they did not create.

export function wordNativeScript() {
  return `(async () => {
    await Office.onReady();
    if (!Office.context.document.url.includes("Acceptance")) throw new Error("Only the owned acceptance fixture may be modified");
    const { createOfficeAdapter } = await import('/office-adapter.js');
    const adapter = createOfficeAdapter({ Office, Word: globalThis.Word, Excel: globalThis.Excel, host: 'word' });
    const descriptor = await adapter.descriptor();
    if (descriptor.host !== 'word') throw new Error('Wrong host');
    let checks = 0;
    const skipped = [];
    const operation = () => crypto.randomUUID();
    // Search-result ranges are untracked proxies: selecting or editing them must happen
    // inside the same Word.run batch that produced the search, otherwise the object path
    // can silently resolve to a different occurrence after document edits.
    const searchCount = async (text) => Word.run(async (ctx) => {
      const found = ctx.document.body.search(text, { matchCase: true });
      found.load('text');
      await ctx.sync();
      return found.items.length;
    });
    const selectFirst = async (text) => Word.run(async (ctx) => {
      const found = ctx.document.body.search(text, { matchCase: true });
      found.load('text');
      await ctx.sync();
      if (!found.items.length) throw new Error('Fixture occurrence missing: ' + text);
      found.items[0].select();
      await ctx.sync();
    });

    // Baseline range/read/replace/duplicate/comment/locate behaviour.
    await Word.run(async ctx => { ctx.document.body.insertText('Acceptance original fragment', 'Replace'); ctx.document.body.paragraphs.getFirst().getRange().select(); await ctx.sync(); });
    const expected = await adapter.execute('readSelection');
    if (!expected.data.text.includes('Acceptance original')) throw new Error('Native selection mismatch'); checks++;
    const proposal = { operationId: operation(), expected, patch: { kind: 'replaceText', text: 'Acceptance revised fragment' } };
    const receipt = await adapter.execute('applyEdit', proposal);
    if (receipt.status !== 'applied') throw new Error('Native replacement not applied: ' + JSON.stringify(receipt)); checks++;
    let refused = false; try { await adapter.execute('applyEdit', proposal); } catch { refused = true; }
    if (!refused) throw new Error('Duplicate accepted'); checks++;
    await Word.run(async ctx => { ctx.document.body.paragraphs.getFirst().getRange().select(); await ctx.sync(); });
    const comment = await adapter.execute('applyEdit', { operationId: operation(), expected: await adapter.execute('readSelection'), patch: { kind: 'comment', text: 'Native acceptance comment' } });
    if (comment.status !== 'applied' || !comment.commentId) throw new Error('Native comment failed'); checks++;
    await adapter.execute('locate', await adapter.execute('readSelection')); checks++;

    // Anchored duplicate-text handling: two identical paragraphs exist; the anchored
    // occurrence is externally rewritten between proposal and apply while its identical
    // twin still matches the quote. The adapter must refuse the anchored range instead
    // of substituting the twin (DOCUMENT-HOSTS: search never replaces the original area).
    await Word.run(async ctx => {
      ctx.document.body.insertParagraph('Duplicate acceptance fragment', 'End');
      ctx.document.body.insertParagraph('Duplicate acceptance fragment', 'End');
      await ctx.sync();
    });
    await selectFirst('Duplicate acceptance fragment');
    const anchored = await adapter.execute('readSelection');
    await Word.run(async (ctx) => {
      const found = ctx.document.body.search('Duplicate acceptance fragment', { matchCase: true });
      found.load('text');
      await ctx.sync();
      found.items[0].insertText('Externally rewritten first occurrence', 'Replace');
      await ctx.sync();
    });
    let anchoredOutcome;
    try {
      anchoredOutcome = await adapter.execute('applyEdit', { operationId: operation(), expected: anchored, patch: { kind: 'replaceText', text: 'Wrong occurrence' } });
    } catch (error) {
      // Real Word collapses a tracked range whose content was wholly replaced, so the
      // adapter reports staleness as anchor expiry; both outcomes refuse the stale write.
      if (!/expired/.test(String(error.message))) throw error;
      anchoredOutcome = { status: 'refused', reason: 'anchor expired' };
    }
    if (anchoredOutcome.status !== 'refused') throw new Error('Externally changed anchor accepted: ' + JSON.stringify(anchoredOutcome)); checks++;
    const refusalCounts = [await searchCount('Duplicate acceptance fragment'), await searchCount('Externally rewritten first occurrence'), await searchCount('Wrong occurrence')];
    if (refusalCounts[0] !== 1 || refusalCounts[1] !== 1 || refusalCounts[2] !== 0)
      throw new Error('Identical twin was substituted or the refusal leaked a write: ' + JSON.stringify(refusalCounts)); checks++;
    // External-edit freshness is read live: applying to a freshly anchored duplicate
    // occurrence still lands exactly on that occurrence.
    await selectFirst('Duplicate acceptance fragment');
    const twin = await adapter.execute('readSelection');
    const twinReceipt = await adapter.execute('applyEdit', { operationId: operation(), expected: twin, patch: { kind: 'replaceText', text: 'Anchored replacement fragment' } });
    if (twinReceipt.status !== 'applied') throw new Error('Anchored duplicate apply failed: ' + JSON.stringify(twinReceipt)); checks++;
    const countsAfterApply = [await searchCount('Anchored replacement fragment'), await searchCount('Externally rewritten first occurrence'), await searchCount('Duplicate acceptance fragment')];
    if (countsAfterApply[0] !== 1 || countsAfterApply[1] !== 1 || countsAfterApply[2] !== 0) throw new Error('Anchored apply touched the wrong occurrence: ' + JSON.stringify(countsAfterApply)); checks++;

    // Comments restore as native objects in the live document, not only as receipts.
    if (Office.context.requirements.isSetSupported('WordApiDesktop', '1.4')) {
      await Word.run(async (ctx) => {
        const comments = ctx.document.comments;
        comments.load('items');
        await ctx.sync();
        for (const item of comments.items) item.load('content');
        await ctx.sync();
        if (!comments.items.some((item) => String(item.content ?? '').includes('Native acceptance comment'))) throw new Error('Comment not present in the document');
      });
      checks++;
    } else skipped.push('word.comment-verify:WordApiDesktop1.4');

    // Revision tracking: the mode active before the write is restored afterwards, and a
    // pre-existing TrackAll mode is preserved rather than reset by the cleanup path.
    const trackingMode = () => Word.run(async (ctx) => {
      ctx.document.load('changeTrackingMode');
      await ctx.sync();
      return ctx.document.changeTrackingMode;
    });
    await Word.run(async ctx => { ctx.document.body.paragraphs.getFirst().getRange().select(); await ctx.sync(); });
    const modeBefore = await trackingMode();
    const restoreReceipt = await adapter.execute('applyEdit', { operationId: operation(), expected: await adapter.execute('readSelection'), patch: { kind: 'replaceText', text: 'Tracking restore fragment' } });
    if (restoreReceipt.status !== 'applied') throw new Error('Tracked replacement failed: ' + JSON.stringify(restoreReceipt));
    if ((await trackingMode()) !== modeBefore) throw new Error('Change tracking was not restored after the write'); checks++;
    await Word.run(async ctx => {
      ctx.document.changeTrackingMode = 'TrackAll';
      await ctx.sync();
      ctx.document.body.paragraphs.getFirst().getRange().select();
      await ctx.sync();
    });
    const trackAllReceipt = await adapter.execute('applyEdit', { operationId: operation(), expected: await adapter.execute('readSelection'), patch: { kind: 'replaceText', text: 'TrackAll preserved fragment' } });
    if (trackAllReceipt.status !== 'applied' || (await trackingMode()) !== 'TrackAll') throw new Error('Pre-existing TrackAll tracking was not preserved'); checks++;
    if (trackAllReceipt.trackingCleanupError) throw new Error('Tracking cleanup errored separately: ' + trackAllReceipt.trackingCleanupError);
    await Word.run(async ctx => { ctx.document.changeTrackingMode = 'Off'; await ctx.sync(); });

    // Unsupported rich-content replacement refuses: plain text never replaces tables.
    await Word.run(async ctx => {
      ctx.document.body.insertTable(2, 2, 'End', [['Table cell content', 'Second'], ['Third', 'Fourth']]);
      await ctx.sync();
    });
    await selectFirst('Table cell content');
    const tableReceipt = await adapter.execute('applyEdit', { operationId: operation(), expected: await adapter.execute('readSelection'), patch: { kind: 'replaceText', text: 'Must not replace tables' } });
    if (tableReceipt.status !== 'refused' || !String(tableReceipt.reason ?? '').includes('tables or pictures')) throw new Error('Table replacement not refused: ' + JSON.stringify(tableReceipt)); checks++;
    if ((await searchCount('Table cell content')) !== 1) throw new Error('Refused write changed the table'); checks++;
    return { checks, skipped };
  })()`;
}

export function excelNativeScript() {
  return `(async () => {
    await Office.onReady();
    if (!Office.context.document.url.includes("Acceptance")) throw new Error("Only the owned acceptance fixture may be modified");
    const { createOfficeAdapter } = await import('/office-adapter.js');
    const adapter = createOfficeAdapter({ Office, Word: globalThis.Word, Excel: globalThis.Excel, host: 'excel' });
    const descriptor = await adapter.descriptor();
    if (descriptor.host !== 'excel') throw new Error('Wrong host');
    let checks = 0;
    const operation = () => crypto.randomUUID();
    const sheet = (ctx) => ctx.workbook.worksheets.getActiveWorksheet();
    const setupAndSelect = (address, values) => Excel.run(async (ctx) => {
      const range = sheet(ctx).getRange(address);
      if (values) range.values = values;
      range.select();
      await ctx.sync();
    });
    const selectRange = (address) => setupAndSelect(address, null);
    const readCellValues = async (address) => Excel.run(async (ctx) => {
      const range = sheet(ctx).getRange(address);
      range.load('values');
      await ctx.sync();
      return range.values;
    });
    const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

    // Baseline read/formula/stale-refusal/locate behaviour.
    await setupAndSelect('Z1:Z2', [[2], [3]]);
    const expected = await adapter.execute('readSelection');
    if (expected.rows !== 2 || expected.columns !== 1 || expected.data.values[0][0] !== 2) throw new Error('Native range mismatch'); checks++;
    const receipt = await adapter.execute('applyEdit', { operationId: operation(), expected, patch: { kind: 'formulas', data: [['=1+2'], ['=2+3']] } });
    if (receipt.status !== 'applied') throw new Error('Native formula apply failed: ' + JSON.stringify(receipt)); checks++;
    const stale = await adapter.execute('readSelection');
    await Excel.run(async (ctx) => { sheet(ctx).getRange('Z1').values = [[99]]; await ctx.sync(); });
    const refused = await adapter.execute('applyEdit', { operationId: operation(), expected: stale, patch: { kind: 'values', data: [[1], [2]] } });
    if (refused.status !== 'refused') throw new Error('Changed range accepted'); checks++;
    await adapter.execute('locate', await adapter.execute('readSelection')); checks++;

    // Native target identity holds across real user content changes elsewhere.
    await setupAndSelect('X1:X2', [[10], [20]]);
    const identityExpected = await adapter.execute('readSelection');
    await Excel.run(async (ctx) => { sheet(ctx).getRange('A1').values = [[42]]; await ctx.sync(); });
    const identityReceipt = await adapter.execute('applyEdit', { operationId: operation(), expected: identityExpected, patch: { kind: 'values', data: [[11], [21]] } });
    if (identityReceipt.status !== 'applied' || !same(identityReceipt.data, [[11], [21]])) throw new Error('Identity apply not verified: ' + JSON.stringify(identityReceipt)); checks++;
    await selectRange('X1:X2');
    if (!same((await adapter.execute('readSelection')).data.values, [[11], [21]])) throw new Error('Verified values did not persist'); checks++;

    // Renaming the worksheet keeps sheetId-based target identity intact.
    await selectRange('X1:X2');
    const renameExpected = await adapter.execute('readSelection');
    await Excel.run(async (ctx) => { sheet(ctx).name = 'FixtureRenamed'; await ctx.sync(); });
    const renameReceipt = await adapter.execute('applyEdit', { operationId: operation(), expected: renameExpected, patch: { kind: 'values', data: [[12], [22]] } });
    if (renameReceipt.status !== 'applied' || renameReceipt.target.sheetId !== renameExpected.target.sheetId) throw new Error('Sheet rename broke target identity'); checks++;

    // Inserted rows re-resolve the target address: stale snapshots refuse and the
    // user's shifted content survives at its new location.
    await setupAndSelect('X10:X11', [[10], [20]]);
    const shiftedExpected = await adapter.execute('readSelection');
    await Excel.run(async (ctx) => { sheet(ctx).getRange('5:5').insert('Down'); await ctx.sync(); });
    const shiftedReceipt = await adapter.execute('applyEdit', { operationId: operation(), expected: shiftedExpected, patch: { kind: 'values', data: [[1], [2]] } });
    if (shiftedReceipt.status !== 'refused') throw new Error('Shifted target accepted: ' + JSON.stringify(shiftedReceipt)); checks++;
    if (!same(await readCellValues('X11:X12'), [[10], [20]])) throw new Error('User content lost after row insertion'); checks++;

    // Limits: oversized contiguous ranges refuse before values load.
    await selectRange('Y1:Z1000');
    let tooLarge = false;
    try { await adapter.execute('readSelection'); } catch (error) { tooLarge = /1000/.test(String(error.message)); }
    if (!tooLarge) throw new Error('Oversized range accepted'); checks++;

    // Dimensions: the patch shape must match the re-read target.
    await selectRange('X1:X2');
    const dimensionExpected = await adapter.execute('readSelection');
    let dimensionRefused = false;
    try { await adapter.execute('applyEdit', { operationId: operation(), expected: dimensionExpected, patch: { kind: 'values', data: [[1]] } }); } catch (error) { dimensionRefused = /dimensions/.test(String(error.message)); }
    if (!dimensionRefused) throw new Error('Mismatched patch dimensions accepted'); checks++;

    // Merged, spill, legacy-array and protected targets refuse without a write.
    await Excel.run(async (ctx) => { sheet(ctx).getRange('AC1:AD1').merge(); await ctx.sync(); });
    await selectRange('AC1:AD1');
    const mergedReceipt = await adapter.execute('applyEdit', { operationId: operation(), expected: await adapter.execute('readSelection'), patch: { kind: 'values', data: [[1, 1]] } });
    if (mergedReceipt.status !== 'refused') throw new Error('Merged range accepted'); checks++;

    await Excel.run(async (ctx) => { sheet(ctx).getRange('AE1').formulas = [['=SEQUENCE(3)']]; await ctx.sync(); });
    await selectRange('AE2:AE3');
    const spillReceipt = await adapter.execute('applyEdit', { operationId: operation(), expected: await adapter.execute('readSelection'), patch: { kind: 'values', data: [[4], [5]] } });
    if (spillReceipt.status !== 'refused') throw new Error('Spill range accepted'); checks++;

    // The legacy CSE array on AB1:AB2 is seeded by the harness through the same owned
    // Excel instance before this script runs; Office.js cannot create one itself.
    await selectRange('AB1:AB2');
    const arrayReceipt = await adapter.execute('applyEdit', { operationId: operation(), expected: await adapter.execute('readSelection'), patch: { kind: 'values', data: [[1], [2]] } });
    if (arrayReceipt.status !== 'refused') throw new Error('Legacy array range accepted'); checks++;

    await Excel.run(async (ctx) => { sheet(ctx).protection.protect(); await ctx.sync(); });
    await selectRange('X1');
    const protectedReceipt = await adapter.execute('applyEdit', { operationId: operation(), expected: await adapter.execute('readSelection'), patch: { kind: 'values', data: [[13]] } });
    if (protectedReceipt.status !== 'refused') throw new Error('Protected range accepted'); checks++;
    await Excel.run(async (ctx) => { sheet(ctx).protection.unprotect(); await ctx.sync(); });

    // Verified result for an invariant formula: receipt plus a calculated read-back.
    await selectRange('AF1');
    const formulaExpected = await adapter.execute('readSelection');
    const formulaReceipt = await adapter.execute('applyEdit', { operationId: operation(), expected: formulaExpected, patch: { kind: 'formulas', data: [['=1+2']] } });
    if (formulaReceipt.status !== 'applied' || !same(formulaReceipt.data, [['=1+2']])) throw new Error('Invariant formula not verified: ' + JSON.stringify(formulaReceipt)); checks++;
    const formulaReadback = await adapter.execute('readTarget', formulaExpected);
    if (formulaReadback.data.values[0][0] !== 3) throw new Error('Formula did not calculate: ' + JSON.stringify(formulaReadback.data.values)); checks++;
    return { checks, skipped: [] };
  })()`;
}
