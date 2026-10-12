import assert from "node:assert/strict";

async function target(port) {
  for (let attempt = 0; attempt < 240; attempt++) {
    try {
      for (const debugPort of [43482, 43484]) {
        try {
          const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
          const pane = list.find((item) => item.url.startsWith(`https://localhost:${port}/`));
          if (pane) return pane;
        } catch {
          /* Office may share a WebView process between the fixture hosts. */
        }
      }
    } catch {
      /* Only the isolated Office fixture is allowed to start this debug endpoint. */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Office fixture pane not available on ${port}`);
}
async function connect(pane) {
  const socket = new WebSocket(pane.webSocketDebuggerUrl);
  const pending = new Map();
  let sequence = 0;
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const job = pending.get(message.id);
    if (!job) return;
    pending.delete(message.id);
    clearTimeout(job.timer);
    if (message.error) job.reject(new Error(message.error.message));
    else job.resolve(message.result);
  });
  return {
    close: () => socket.close(),
    evaluate: (expression) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Office evaluation timed out"));
        }, 25000);
        pending.set(id, { resolve, reject, timer });
        socket.send(
          JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        );
      }).then((result) => {
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
      }),
  };
}

let total = 0;
for (const [port, host] of [
  [43481, "word"],
  [43483, "excel"],
].filter(
  ([, host]) => !process.argv[2] || process.argv[2] === "both" || process.argv[2] === host,
)) {
  const connection = await connect(await target(port));
  try {
    let ready = false;
    for (let attempt = 0; attempt < 240; attempt++) {
      ready = await connection.evaluate(
        "typeof Office !== 'undefined' && Boolean(document.getElementById('title')?.textContent.startsWith('ZCODE'))",
      );
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error(`Office fixture panel did not initialize for ${host}`);
    const result = await connection.evaluate(`(async () => {
      await Office.onReady();
      if (!Office.context.document.url.includes("Acceptance")) throw new Error("Only the owned acceptance fixture may be modified");
      const { createOfficeAdapter } = await import('/office-adapter.js');
      const adapter = createOfficeAdapter({ Office, Word: globalThis.Word, Excel: globalThis.Excel, host: ${JSON.stringify(host)} });
      const descriptor = await adapter.descriptor();
      if (descriptor.host !== ${JSON.stringify(host)}) throw new Error('Wrong host');
      let checks = 1;
      if (${JSON.stringify(host)} === 'word') {
        await Word.run(async ctx => { ctx.document.body.insertText('Acceptance original fragment', 'Replace'); ctx.document.body.paragraphs.getFirst().getRange().select(); await ctx.sync(); });
        const expected = await adapter.execute('readSelection');
        if (!expected.data.text.includes('Acceptance original')) throw new Error('Native selection mismatch'); checks++;
        const proposal = { operationId: crypto.randomUUID(), expected, patch: { kind: 'replaceText', text: 'Acceptance revised fragment' } };
        const receipt = await adapter.execute('applyEdit', proposal);
        if (receipt.status !== 'applied') throw new Error('Native replacement not applied: ' + JSON.stringify(receipt)); checks++;
        let refused = false; try { await adapter.execute('applyEdit', proposal); } catch { refused = true; }
        if (!refused) throw new Error('Duplicate accepted'); checks++;
        await Word.run(async ctx => { ctx.document.body.paragraphs.getFirst().getRange().select(); await ctx.sync(); });
        const comment = await adapter.execute('applyEdit', { operationId: crypto.randomUUID(), expected: await adapter.execute('readSelection'), patch: { kind: 'comment', text: 'Native acceptance comment' } });
        if (comment.status !== 'applied' || !comment.commentId) throw new Error('Native comment failed'); checks++;
        await adapter.execute('locate', await adapter.execute('readSelection')); checks++;
      } else {
        await Excel.run(async ctx => { const range = ctx.workbook.worksheets.getActiveWorksheet().getRange('Z1:Z2'); range.values = [[2], [3]]; range.select(); await ctx.sync(); });
        const expected = await adapter.execute('readSelection');
        if (expected.rows !== 2 || expected.columns !== 1 || expected.data.values[0][0] !== 2) throw new Error('Native range mismatch'); checks++;
        const receipt = await adapter.execute('applyEdit', { operationId: crypto.randomUUID(), expected, patch: { kind: 'formulas', data: [['=1+2'], ['=2+3']] } });
        if (receipt.status !== 'applied') throw new Error('Native formula apply failed: ' + JSON.stringify(receipt)); checks++;
        const stale = await adapter.execute('readSelection');
        await Excel.run(async ctx => { ctx.workbook.worksheets.getActiveWorksheet().getRange('Z1').values = [[99]]; await ctx.sync(); });
        const refused = await adapter.execute('applyEdit', { operationId: crypto.randomUUID(), expected: stale, patch: { kind: 'values', data: [[1], [2]] } });
        if (refused.status !== 'refused') throw new Error('Changed range accepted'); checks++;
        await adapter.execute('locate', await adapter.execute('readSelection')); checks++;
      }
      if (!document.getElementById('connect-form') || !document.getElementById('side') || !document.getElementById('discuss')) throw new Error('Shared panel controls missing'); checks++;
      if (!document.getElementById('send').disabled) throw new Error('Offline pane can submit to a model'); checks++;
      // Exercise the shared UI with a local fake command facade, never a gateway or model.
      const freshPage = new DOMParser().parseFromString(await (await fetch('/')).text(), 'text/html');
      document.body.replaceChildren(...[...freshPage.body.childNodes].map(node => node.cloneNode(true)));
      const { mountDocumentPane } = await import('/pane.js');
      const pane = await mountDocumentPane(adapter, ${JSON.stringify(host)} === 'word' ? 'Word' : 'Excel');
      const projection = { config: { mode: 'build', model: 'fixture', provider: 'fixture', thought: 'low' }, control: { canStop: false, activeWorks: [] }, rows: { window: [] }, pendingInteractions: [] };
      pane.client.socket = { readyState: 1, close() {} }; pane.client.generation = 'ui-fixture';
      pane.client.lease = { sessionId: 'fixture-session', store: { getState: () => ({ snapshot: projection }) }, release() {} };
      const settleFrame = async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); };
      pane.client.changed(); await settleFrame();
      let accept; pane.client.command = async () => new Promise(resolve => { accept = resolve; });
      const prompt = document.getElementById('prompt'); prompt.value = 'Submitted draft'; document.getElementById('composer').requestSubmit();
      for (let i = 0; i < 10 && !accept; i++) await settleFrame();
      if (!accept) throw new Error('Fixture send was not admitted');
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
      return { host: descriptor.host, checks };
    })()`);
    total += result.checks;
    console.info(`${host}: ${result.checks - 3} native Office API + 3 shared UI checks passed`);
  } finally {
    connection.close();
  }
}
assert.ok(total >= (["word", "excel"].includes(process.argv[2]) ? 10 : 21));
console.info(`Office native acceptance: ${total} checks, no ZCODE or model connected`);
