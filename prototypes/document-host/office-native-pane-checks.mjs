// Shared pane fixture checks (O-04/O-05 fixture halves) executed inside the isolated
// Office pane WebView. They exercise the shared ZCODE surface with a local fake
// command facade and the real adapter on the owned disposable document; no gateway,
// ZCODE process or model is contacted.

export function paneFixtureScript(host) {
  const hostName = host === "word" ? "Word" : "Excel";
  return `(async () => {
    await Office.onReady();
    // The offline (bootstrap-mounted) pane must expose the shared controls with the
    // send action disabled before anything connects; checked before the remount below.
    if (!document.getElementById('connect-form') || !document.getElementById('side') || !document.getElementById('discuss')) throw new Error('Shared panel controls missing');
    let offlineChecks = 1;
    if (!document.getElementById('send').disabled) throw new Error('Offline pane can submit to a model'); offlineChecks++;
    const freshPage = new DOMParser().parseFromString(await (await fetch('/')).text(), 'text/html');
    document.body.replaceChildren(...[...freshPage.body.childNodes].map(node => node.cloneNode(true)));
    const { mountDocumentPane } = await import('/pane.js');
    const { createOfficeAdapter } = await import('/office-adapter.js');
    const adapter = createOfficeAdapter({ Office, Word: globalThis.Word, Excel: globalThis.Excel, host: ${JSON.stringify(host)} });
    const pane = await mountDocumentPane(adapter, ${JSON.stringify(hostName)});
    const projection = { config: { mode: 'build', model: 'fixture', provider: 'fixture', thought: 'low' }, control: { canStop: false, activeWorks: [] }, rows: { window: [] }, pendingInteractions: [] };
    pane.client.socket = { readyState: 1, close() {} }; pane.client.generation = 'ui-fixture';
    pane.client.lease = { sessionId: 'fixture-session', store: { getState: () => ({ snapshot: projection }) }, release() {} };
    const settleFrame = async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); };
    const waitFor = async (predicate, message) => { for (let i = 0; i < 150 && !predicate(); i++) await settleFrame(); if (!predicate()) throw new Error(message); };
    let checks = 0;
    pane.client.changed(); await settleFrame();
    let accept; pane.client.command = async () => new Promise(resolve => { accept = resolve; });
    const prompt = document.getElementById('prompt'); prompt.value = 'Submitted draft'; document.getElementById('composer').requestSubmit();
    await waitFor(() => Boolean(accept), 'Fixture send was not admitted');
    prompt.value = 'New text during ACK wait'; accept({ status: 'accepted' }); await settleFrame();
    if (prompt.value !== 'New text during ACK wait') throw new Error('Composer erased a newer draft'); checks++;
    projection.pendingInteractions = [{ interactionId: 'fixture-question', payload: { kind: 'userInput', prompt: 'Fixture input', freeText: true } }];
    pane.client.changed(); await settleFrame();
    const input = document.querySelector('#messages input'); input.value = 'Keep this answer'; input.focus();
    projection.rows.window = [{ rowId: 1, kind: 'assistantText', text: 'A streaming row' }];
    pane.client.changed(); await settleFrame();
    if (document.querySelector('#messages input') !== input || input.value !== 'Keep this answer' || document.activeElement !== input) throw new Error('Streaming erased an interaction draft or focus'); checks++;
    let answer;
    pane.client.command = async (type, payload, sessionId) => { answer = { type, payload, sessionId }; return { status: 'accepted' }; };
    projection.pendingInteractions = [{ interactionId: 'fixture-multiple', payload: { kind: 'userInput', questions: [{ question: 'Choose operations', multiSelect: true, options: [{ label: 'Keep', value: 'keep' }, { label: 'Review', value: 'review' }] }] } }];
    pane.client.changed(); await settleFrame();
    document.querySelector('#messages input[value="keep"]').click();
    document.querySelector('#messages input[value="review"]').click();
    const custom = document.querySelector('#messages textarea'); custom.value = 'Only this selection'; custom.dispatchEvent(new Event('input'));
    [...document.querySelectorAll('#messages button')].find(button => button.textContent === 'Ответить').click(); await settleFrame();
    if (answer?.type !== 'resolveInteraction' || answer.sessionId !== 'fixture-session' || answer.payload.answer.action !== 'accept' || answer.payload.answer.content.answers['Choose operations'] !== 'keep, review, Only this selection') throw new Error('Native question answer shape mismatch'); checks++;

    // O-04 fixture half: every required screen control has an ID and an accessible
    // name; state and error surfaces expose their live descriptions.
    const described = ['theme', 'endpoint', 'workspace', 'token', 'disconnect', 'document-tab', 'side', 'discussion-tab', 'read', 'discuss', 'locate', 'stop', 'add-context', 'mode', 'send', 'prompt'];
    for (const id of described) {
      const element = document.getElementById(id);
      if (!element) throw new Error('Required control missing: ' + id);
      const name = element.getAttribute('aria-label') || element.title || (element.labels?.length ? element.labels[0].textContent : '') || element.textContent.trim();
      if (!name.trim()) throw new Error('Control has no accessible name: ' + id);
    }
    checks++;
    if (document.getElementById('status').getAttribute('role') !== 'status' || document.getElementById('messages').getAttribute('aria-live') !== 'polite') throw new Error('Live state descriptions missing');
    const model = document.getElementById('model');
    if (model.tagName !== 'SPAN' || !model.title.includes('Настройки берутся из ZCODE')) throw new Error('Model choice is not absent-with-reason');
    if (![...document.querySelectorAll('footer .footnote')].some((note) => note.textContent.includes('Вложения недоступны'))) throw new Error('Attachment absence reason missing'); checks++;

    // Shared ZCODE theme tokens respond to the pane theme toggle.
    const surfaceColor = () => getComputedStyle(document.body).backgroundColor;
    const initialColor = surfaceColor();
    document.getElementById('theme').click(); await settleFrame();
    const toggledColor = surfaceColor();
    document.getElementById('theme').click(); await settleFrame();
    if (toggledColor === initialColor || surfaceColor() !== initialColor) throw new Error('Theme toggle does not switch the shared theme');
    if (!getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()) throw new Error('Shared theme tokens missing'); checks++;

    // Keyboard and IME: Enter submits, Shift+Enter and IME composition never submit.
    let submitted = 0;
    const composer = document.getElementById('composer');
    const countSubmit = () => { submitted++; };
    composer.addEventListener('submit', countSubmit);
    prompt.value = '';
    prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settleFrame();
    if (submitted !== 1) throw new Error('Enter did not submit the composer draft');
    prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, shiftKey: true }));
    prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
    await settleFrame();
    if (submitted !== 1) throw new Error('Shift+Enter or IME composition submitted unexpectedly');
    composer.removeEventListener('submit', countSubmit); checks++;

    // O-05 fixture half: a bounded proposal applies exactly once on the user action,
    // the receipt is verified against the live document, stale targets refuse and a
    // reconnected pane only continues from a fresh read.
    const selectProposalTarget = () => ${JSON.stringify(host)} === 'word'
      ? Word.run(async ctx => { ctx.document.body.paragraphs.getFirst().getRange().select(); await ctx.sync(); })
      : Excel.run(async ctx => { ctx.workbook.worksheets.getActiveWorksheet().getRange('AF1').select(); await ctx.sync(); });
    const makePatch = (text, value) => ${JSON.stringify(host)} === 'word' ? { kind: 'replaceText', text } : { kind: 'values', data: [[value]] };
    // Word collapses a tracked range whose content was wholly replaced, so the readback
    // re-reads the live document instead of the consumed anchor; Excel re-reads by address.
    const verifyApplied = async (text, value) => {
      if (${JSON.stringify(host)} !== 'word') {
        await selectProposalTarget();
        return (await adapter.execute('readSelection')).data.values[0][0] === value;
      }
      return Word.run(async (ctx) => {
        const found = ctx.document.body.search(text, { matchCase: true });
        found.load('text');
        await ctx.sync();
        return found.items.length === 1 && found.items[0].text.trim() === text;
      });
    };
    await selectProposalTarget();
    const expected = await adapter.execute('readSelection');
    const operationId = crypto.randomUUID();
    pane.client.proposals.set(operationId, { operationId, generation: 'ui-fixture', documentInstanceId: expected.documentInstanceId, expected, patch: makePatch('Pane applied edit', 7), explanation: 'Fixture proposal', status: 'pending' });
    pane.client.changed(); await settleFrame();
    const applyControl = [...document.querySelectorAll('#proposals button')].find(button => button.textContent === 'Применить');
    if (!applyControl) throw new Error('Pending proposal exposes no apply control');
    applyControl.click();
    await waitFor(() => pane.client.proposals.get(operationId)?.status === 'applied', 'User apply did not produce an applied receipt');
    if (!pane.client.proposals.get(operationId).receipt) throw new Error('Applied proposal has no receipt'); checks++;
    if (!(await verifyApplied('Pane applied edit', 7))) throw new Error('Applied edit is not verifiable in the live document'); checks++;
    let duplicated = false; try { await pane.client.apply(operationId); } catch { duplicated = true; }
    if (!duplicated) throw new Error('Duplicate apply of one operation was accepted'); checks++;
    if (${JSON.stringify(host)} === 'word') await Word.run(async ctx => {
      const found = ctx.document.body.search('Pane applied edit', { matchCase: true });
      found.load('text');
      await ctx.sync();
      found.items[0].insertText('Externally changed during review', 'Replace');
      await ctx.sync();
    });
    else await Excel.run(async ctx => { ctx.workbook.worksheets.getActiveWorksheet().getRange('AF1').values = [[99]]; await ctx.sync(); });
    const staleOperation = crypto.randomUUID();
    pane.client.proposals.set(staleOperation, { operationId: staleOperation, generation: 'ui-fixture', documentInstanceId: expected.documentInstanceId, expected, patch: makePatch('Pane applied edit', 7), explanation: 'Fixture stale proposal', status: 'pending' });
    pane.client.changed(); await settleFrame();
    let staleOutcome;
    try {
      staleOutcome = await pane.client.apply(staleOperation);
    } catch (error) {
      // The collapsed Word anchor surfaces staleness as anchor expiry before any write;
      // both the refused receipt and the expiry rejection are honest stale outcomes.
      if (!/expired|changed/i.test(String(error.message))) throw error;
      staleOutcome = { status: 'refused' };
    }
    if (staleOutcome.status !== 'refused') throw new Error('Stale target accepted after an external change'); checks++;
    const reconnectedPage = new DOMParser().parseFromString(await (await fetch('/')).text(), 'text/html');
    document.body.replaceChildren(...[...reconnectedPage.body.childNodes].map(node => node.cloneNode(true)));
    const pane2 = await mountDocumentPane(adapter, ${JSON.stringify(hostName)});
    if (pane2.client.proposals.size !== 0) throw new Error('Reconnected pane inherited old proposals');
    let oldRejected = false; try { await pane2.client.apply(operationId); } catch { oldRejected = true; }
    if (!oldRejected) throw new Error('Old operation survived reconnect'); checks++;
    pane2.client.socket = { readyState: 1, close() {} }; pane2.client.generation = 'ui-fixture-2';
    await selectProposalTarget();
    const recovered = await adapter.execute('readSelection');
    const recoveredOperation = crypto.randomUUID();
    pane2.client.proposals.set(recoveredOperation, { operationId: recoveredOperation, generation: 'ui-fixture-2', documentInstanceId: recovered.documentInstanceId, expected: recovered, patch: makePatch('Recovered fragment', 8), explanation: 'Post-reconnect proposal', status: 'pending' });
    pane2.client.changed(); await settleFrame();
    [...document.querySelectorAll('#proposals button')].find(button => button.textContent === 'Применить')?.click();
    await waitFor(() => pane2.client.proposals.get(recoveredOperation)?.status === 'applied', 'Post-reconnect apply did not succeed'); checks++;
    return { checks: checks + offlineChecks, skipped: [] };
  })()`;
}

export function paneNarrowLayoutScript() {
  return `(() => {
    const root = document.documentElement;
    const composerBox = document.getElementById('prompt').getBoundingClientRect();
    return {
      overflow: root.scrollWidth - root.clientWidth,
      wrapped: document.getElementById('model').offsetTop > document.getElementById('send').offsetTop,
      composerReachable: composerBox.width > 0 && composerBox.height > 0,
    };
  })()`;
}
