import { app, BrowserWindow } from "electron";
import { build, transform } from "esbuild";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../../..");
const dir = await mkdtemp(join(tmpdir(), "zcode-native-popout-proof-"));
app.setPath("userData", join(dir, "profile"));
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(predicate, label) {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await wait(50); }
  throw new Error(`Timed out: ${label}`);
}
app.whenReady().then(async () => {
  try {
    const nativeSource = await readFile(join(root, "packages/desktop/src/main/nativeConversationPopouts.ts"), "utf8");
    const compiled = await transform(nativeSource, { loader: "ts", format: "esm" });
    const nativeFile = join(dir, "native.mjs");
    await writeFile(nativeFile, compiled.code);
    const { installNativeConversationPopouts, isNativeConversationPopout } = await import(pathToFileURL(nativeFile).href);
    const bundle = await build({
      absWorkingDir: join(root, "packages/ui"),
      tsconfig: join(root, "packages/ui/tsconfig.json"),
      stdin: { resolveDir: join(root, "packages/ui"), loader: "tsx", contents: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { PlatformProvider } from './src/hooks/usePlatform.js';
        import { useSpecPopoutRegion, SpecPopoutRegionPortal } from './src/spec-document/specPopoutRegion.js';
        import { Popover, PopoverTrigger, PopoverContent } from './src/components/ui/popover.js';
        import { LexicalComposer } from '@lexical/react/LexicalComposer';
        import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
        import { ContentEditable } from '@lexical/react/LexicalContentEditable';
        import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
        import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
        import { $getRoot } from 'lexical';
        import { PresentationDocumentPlugin } from './src/prompt-editor/PresentationDocumentPlugin.js';
        import { openNativeConversationPopout } from '../desktop/src/renderer/src/nativeConversationPopout.js';
        window.proof = { regions: {}, renders: 0, returnCount: 0 };
        function Surface({id}) {
          const region = useSpecPopoutRegion({regionId:id, workspaceKey:'proof', title:id, onReturn:()=>{window.proof.returnCount++;}});
          const [value,setValue] = useState('draft-'+id);
          const [count,setCount] = useState(0);
          window.proof.regions[id] = region;
          window.proof.renders++;
          return <div><button id={'open-'+id} onClick={region.open}>Open</button><div ref={region.anchorRef}/>
            <SpecPopoutRegionPortal region={region} title={id}>
              <input id={'draft-'+id} value={value} onChange={e=>setValue(e.target.value)}/>
              <button id={'count-'+id} onClick={()=>setCount(count+1)}>{count}</button>
              <Popover><PopoverTrigger id={'menu-'+id}>Models</PopoverTrigger><PopoverContent><span>model-choice</span></PopoverContent></Popover>
              <output id={'value-'+id}>{value}</output>
              <LexicalComposer initialConfig={{namespace:id,onError:e=>{throw e;}}}>
                <PresentationDocumentPlugin/>
                <PlainTextPlugin contentEditable={<ContentEditable id={'lexical-'+id}/>} ErrorBoundary={LexicalErrorBoundary}/>
                <OnChangePlugin onChange={state=>state.read(()=>{window.proof.lexical=$getRoot().getTextContent();})}/>
              </LexicalComposer>
            </SpecPopoutRegionPortal>
          </div>;
        }
        window.fixtureRoot = createRoot(document.getElementById('root'));
        window.fixtureRoot.render(<PlatformProvider platform={{openConversationPopout:openNativeConversationPopout}}><Surface id="chat"/><Surface id="doc1"/><Surface id="doc2"/></PlatformProvider>);
      ` },
      bundle: true, write: false, platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' },
    });
    await writeFile(join(dir, "fixture.js"), bundle.outputFiles[0].text);
    const file = join(dir, "index.html");
    await writeFile(file, '<!doctype html><html class="dark"><head><style>.dark{--color-background:#161616;--color-foreground:#dddddd}input{color:rgb(1,2,3)}</style></head><body><div id="root"></div><script src="./fixture.js"></script></body></html>');
    const main = new BrowserWindow({ show: true, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
    installNativeConversationPopouts(main, () => false);
    await main.loadFile(file);
    await until(() => main.webContents.executeJavaScript('!!window.proof?.regions?.chat'), 'React mounted');
    await main.webContents.executeJavaScript("document.getElementById('lexical-chat').focus()",true);
    await main.webContents.insertText('before');
    await until(() => main.webContents.executeJavaScript("window.proof.lexical === 'before'"), 'Lexical draft before detachment');
    for (const id of ['chat','doc1','doc2']) {
      await main.webContents.executeJavaScript(`document.getElementById('open-${id}').click()`,true);
      await until(() => main.webContents.executeJavaScript(`window.proof.regions.${id}.popped`), `${id} opened`);
    }
    const aux = BrowserWindow.getAllWindows().filter(isNativeConversationPopout);
    if (aux.length !== 3 || aux.some(w=>!w.isAlwaysOnTop())) throw new Error('Expected three topmost native windows');
    const chat = aux.find(w=>w.getTitle().endsWith('chat'));
    if (!chat) throw new Error('Chat window missing');
    const proof = await chat.webContents.executeJavaScript(`(() => {
      document.getElementById('count-chat').click();
      document.getElementById('draft-chat').focus();
      return { width:innerWidth, color:getComputedStyle(document.getElementById('draft-chat')).color, background:getComputedStyle(document.body).backgroundColor, bodyHeight:document.body.clientHeight, nodeDisabled:typeof require==='undefined' };
    })()`, true);
    if (proof.background !== 'rgb(22, 22, 22)' || proof.bodyHeight <= 0) throw new Error('Native window lost theme/background or height');
    await chat.webContents.insertText(' typed');
    await until(() => chat.webContents.executeJavaScript("document.getElementById('value-chat').textContent.includes('typed')"), 'React input');
    await chat.webContents.executeJavaScript("document.getElementById('lexical-chat').focus()",true);
    await chat.webContents.insertText(' lexical typed');
    await until(() => main.webContents.executeJavaScript("window.proof.lexical.includes('before') && window.proof.lexical.includes('lexical typed')"), 'Lexical input in child');
    await chat.webContents.executeJavaScript("document.getElementById('menu-chat').click()",true);
    await until(() => chat.webContents.executeJavaScript("!!document.querySelector('[data-slot=popover-content]')"), 'child menu');
    if (await main.webContents.executeJavaScript("!!document.querySelector('[data-slot=popover-content]')")) throw new Error('Menu appeared in parent');
    main.close();
    if (main.isDestroyed() || main.isVisible()) throw new Error('Main X must hide, retain owner');
    chat.close();
    await until(() => main.webContents.executeJavaScript('!window.proof.regions.chat.popped'), 'OS close restores portal');
    const returned = await main.webContents.executeJavaScript("({text:document.getElementById('draft-chat').value,count:document.getElementById('count-chat').textContent})");
    if (!returned.text.includes('typed') || returned.count !== '1') throw new Error('React state lost');
    await main.webContents.executeJavaScript("document.getElementById('lexical-chat').focus()",true);
    await main.webContents.insertText(' returned');
    await until(() => main.webContents.executeJavaScript("window.proof.lexical.includes('returned') && window.proof.lexical.includes('lexical typed')"), 'Lexical input after Return');
    for (const child of BrowserWindow.getAllWindows().filter(isNativeConversationPopout)) child.close();
    await until(() => main.isVisible(), 'last Return reveals owner');
    for (let i=0;i<20;i++) {
      await main.webContents.executeJavaScript("document.getElementById('open-chat').click()",true);
      await until(() => main.webContents.executeJavaScript('window.proof.regions.chat.popped'), 'cycle open');
      await main.webContents.executeJavaScript('window.proof.regions.chat.close()',true);
      await until(() => BrowserWindow.getAllWindows().filter(isNativeConversationPopout).length===0, 'cycle return');
    }
    if (await main.webContents.executeJavaScript('window.proof.returnCount') !== 23) throw new Error('Return callback count mismatch');
    await main.webContents.executeJavaScript("document.getElementById('open-chat').click()",true);
    await until(() => main.webContents.executeJavaScript('window.proof.regions.chat.popped'), 'teardown fixture open');
    await main.webContents.executeJavaScript('window.fixtureRoot.unmount()');
    await until(() => BrowserWindow.getAllWindows().filter(isNativeConversationPopout).length===0, 'teardown closes child');
    if (await main.webContents.executeJavaScript('window.proof.returnCount') !== 23) throw new Error('Teardown must not navigate');
    console.log(JSON.stringify({ ...proof, ...returned, simultaneousWindows:aux.length, cycles:20, remainingWindows:BrowserWindow.getAllWindows().length }));
    console.log('PASS production native policy + React portal + input + child menu + OS close + main hide + 20 cycles');
  } catch (error) { console.error(error); process.exitCode=1; }
  finally { app.exit(process.exitCode || 0); }
});
