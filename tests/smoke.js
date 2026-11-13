/**
 * End-to-end smoke test: loads the built extension (dist/) into Chromium,
 * opens a small test page, and drives the side panel UI against it.
 *
 * The side panel can't be opened as a real side panel from automation, so
 * its page is opened in a tab and chrome.tabs.query is stubbed to point it
 * at the test page's tab. Everything else is the real extension.
 *
 *   npm test
 */
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const EXT = path.join(__dirname, '..', 'dist'); // run `npm run build` first (npm test does)
const assert = (c, m) => { if (!c) { throw new Error('ASSERT: ' + m); } console.log('  ok -', m); };
(async () => {
  const server = http.createServer((q, r) => {
    const f = path.join(__dirname, 'site', q.url.split('?')[0] === '/' ? 'index.html' : q.url.split('?')[0]);
    if (q.url === '/favicon.ico') { r.writeHead(204); return r.end(); }
    if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { 'content-type': f.endsWith('.css') ? 'text/css' : 'text/html' }); r.end(fs.readFileSync(f));
  }).listen(0);
  const URL = `http://localhost:${server.address().port}/`;
  const ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  const errors = [];
  const watch = (p, tag) => { p.on('pageerror', e => errors.push(`${tag}: ${e.message}`)); p.on('console', m => { if (m.type() === 'error') errors.push(`${tag} console: ${m.text()}`); }); };
  const page = await ctx.newPage(); watch(page, 'page');
  await page.goto(URL);
  let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  const tab = await sw.evaluate(async (u) => { const [t] = await chrome.tabs.query({ url: u + '*' }); return { id: t.id, windowId: t.windowId }; }, URL);
  await ctx.addInitScript((t) => { if (location.protocol === 'chrome-extension:' && chrome.tabs) chrome.tabs.query = async () => [t]; }, tab);
  const panel = await ctx.newPage(); watch(panel, 'panel');
  await panel.goto(`chrome-extension://${extId}/sidepanel/index.html`);
  const css = (sel, prop) => page.evaluate(([s, p]) => { const e = document.querySelector(s); return e ? getComputedStyle(e)[p] : null; }, [sel, prop]);
  const row = (text) => panel.locator('#tree .tree-row[data-selector-key]', { hasText: text }).last();
  const settle = () => panel.waitForTimeout(500);

  console.log('tree'); await panel.waitForSelector('#tree .tree-row');
  assert(await panel.locator('#tree .tree-row[data-selector-key]').count() === 2, 'root shows head + body only (no injected nodes)');
  await row('<body').locator('.tree-toggle').click(); await settle();
  await row('id="app"').locator('.tree-toggle').click(); await settle();
  await row('class="card"').locator('.tree-toggle').click(); await settle();
  assert(await row('class="btn"').count() === 1, 'expanded down to .btn');

  console.log('select + styles'); await row('class="card"').click(); await settle();
  const rules = await panel.locator('#styles .rule-selector').allTextContents();
  assert(rules.includes('element.style') && rules.includes('.card'), 'matched rules listed: ' + rules.join(' | '));
  assert((await panel.locator('#styles').textContent()).includes('"a;b"'), 'quoted semicolon value parsed intact');
  assert(await panel.locator('#breadcrumbs .crumb').count() >= 3, 'breadcrumbs rendered');
  assert(await panel.locator('#box .box-diagram').count() === 1, 'box model rendered');

  console.log('add property'); 
  const cardRule = panel.locator('#styles .style-rule', { has: panel.locator('.rule-selector', { hasText: /^\.card$/ }) }).first();
  await cardRule.locator('.prop-add').click();
  await panel.keyboard.type('background-color'); await panel.keyboard.press('Tab'); await panel.keyboard.type('rgb(10, 20, 30)'); await panel.keyboard.press('Enter'); await settle();
  assert(await css('.card', 'backgroundColor') === 'rgb(10, 20, 30)', 'added property applied on page');
  assert(await panel.locator('#changes-badge').textContent() === '1', 'changes badge = 1');

  console.log('toggle author property');
  const colorRow = () => panel.locator('#styles .style-rule', { has: panel.locator('.rule-selector', { hasText: /^\.card$/ }) }).locator('.prop-row', { has: panel.locator('.prop-name', { hasText: /^color$/ }) });
  await colorRow().locator('.prop-checkbox').click(); await settle();
  assert(await css('.card', 'color') !== 'rgb(0, 0, 255)', 'unchecked color no longer applies');
  assert(await panel.locator('#styles .rule-selector', { hasText: /^\.card$/ }).count() === 2, 'no duplicate rule row after uncheck');
  await colorRow().locator('.prop-checkbox').click(); await settle();
  assert(await css('.card', 'color') === 'rgb(0, 0, 255)', 're-checked color restored');

  console.log('edit value + shorthand + escape');
  const padRow = () => panel.locator('#styles .prop-row', { has: panel.locator('.prop-name', { hasText: /^padding$/ }) }).first();
  await padRow().locator('.prop-value').click(); await panel.keyboard.type('20px'); await panel.keyboard.press('Enter'); await settle();
  assert(await css('.card', 'paddingTop') === '20px', 'shorthand edit applied');
  await padRow().locator('.prop-value').click(); await panel.keyboard.type('33px'); await panel.waitForTimeout(100); await panel.keyboard.press('Escape'); await settle();
  assert(await css('.card', 'paddingTop') === '20px', 'Escape restores previous edit (shorthand rule replaced, not stacked)');
  await panel.waitForTimeout(1200); // let the undo-coalescing window close
  await padRow().locator('.prop-value').click(); await panel.keyboard.press('ArrowUp'); await panel.keyboard.press('Enter'); await settle();
  assert(await css('.card', 'paddingTop') === '21px', 'ArrowUp steps numeric value');

  console.log('undo/redo');
  await panel.locator('#btn-undo').click(); await settle();
  assert(await css('.card', 'paddingTop') === '20px', 'undo');
  await panel.locator('#btn-redo').click(); await settle();
  assert(await css('.card', 'paddingTop') === '21px', 'redo');

  console.log(':hov');
  await row('class="btn"').click(); await settle();
  assert((await panel.locator('#styles .rule-pseudo').allTextContents()).join().includes(':hover'), 'hover rule listed with chip');
  assert((await panel.locator('#styles .rule-pseudo').allTextContents()).join().includes(':focus-visible'), 'focus-visible rule listed');
  assert(await panel.locator('#hov-row').isHidden(), ':hov row hidden initially');
  await panel.locator('#btn-hov').click(); await panel.locator('#hov-row input[data-state="hover"]').check(); await settle();
  assert(await css('.btn', 'color') === 'rgb(255, 0, 0)', 'forced :hover applies');
  assert(!(await panel.locator('#tree').textContent()).includes('desinspect-fs'), 'marker class hidden from tree');
  assert(!(await panel.locator('#styles').textContent()).includes('desinspect-fs'), 'forced-sheet rules not listed as author rules');
  await row('class="label"').click(); await settle();
  assert(await css('.btn', 'color') === 'rgb(1, 2, 3)', 'forced state cleared on reselect');
  assert(await page.evaluate(() => document.querySelector('.btn').getAttribute('class')) === 'btn', 'no marker class left behind');

  console.log('edit as HTML (span → button)');
  await row('class="label"').dblclick(); await panel.waitForSelector('.tree-edit-textarea');
  await panel.locator('.tree-edit-textarea').fill('<button class="label2" data-x=1>New & improved</button>');
  await panel.keyboard.press('Control+Enter'); await settle(); await settle();
  assert(await page.evaluate(() => document.querySelector('button.label2')?.textContent) === 'New & improved', 'span replaced by button');
  assert(await page.evaluate(() => !document.querySelector('span.label')), 'old span gone');
  assert((await panel.locator('#status').textContent()) !== '' && await panel.locator('#styles .empty').count() === 0, 'selection follows the replaced element');
  await page.waitForTimeout(2500);
  const stable = await page.evaluate(() => { const b = document.querySelector('button.label2'); b.__mark = 1; return new Promise(r => setTimeout(() => r(document.querySelector('button.label2').__mark === 1), 2500)); });
  assert(stable, 'HTML edit is not re-swapped by reapply loop');

  console.log('delete element + undo');
  await row('class="list"').locator('.tree-toggle').click(); await settle();
  await panel.locator('#tree .tree-row[data-selector-key]', { hasText: '<li' }).first().click(); await settle();
  await panel.locator('#tree').press('Delete'); await settle(); await settle();
  assert(await page.evaluate(() => document.querySelectorAll('li').length) === 2, 'li deleted');
  await page.waitForTimeout(2500);
  assert(await page.evaluate(() => document.querySelectorAll('li').length) === 2, 'no escalating deletes on reapply');
  await panel.keyboard.press('Control+z'); await settle(); await settle();
  assert(await page.evaluate(() => [...document.querySelectorAll('li')].map(l => l.textContent).join()) === 'one,two,three', 'undo restores li in place');
  await panel.keyboard.press('Control+Shift+z'); await settle(); await settle();
  assert(await page.evaluate(() => document.querySelectorAll('li').length) === 2, 'redo deletes again');

  console.log('persistence across reload');
  await page.waitForTimeout(600); await page.reload(); await page.waitForTimeout(1500);
  assert(await css('.card', 'backgroundColor') === 'rgb(10, 20, 30)', 'CSS persisted');
  assert(await css('.card', 'paddingTop') === '21px', 'shorthand persisted');
  assert(await page.evaluate(() => !!document.querySelector('button.label2')), 'HTML edit persisted');
  assert(await page.evaluate(() => document.querySelectorAll('li').length) === 2, 'delete persisted');
  await settle(); await settle();
  assert(await panel.locator('#changes-badge').textContent() === '4', 'panel re-synced after reload (4 changes): ' + await panel.locator('#changes-badge').textContent());

  console.log('snapshot, revert all, undo');
  await panel.locator('[data-tab="snapshots"]').click(); await panel.locator('#snapshot-name').fill('s1'); await panel.locator('#btn-create-snapshot').click(); await settle();
  assert(await panel.locator('.snapshot-row').count() === 1, 'snapshot created');
  panel.on('dialog', d => d.accept());
  await panel.locator('#btn-clear').click(); await settle(); await settle();
  assert(await css('.card', 'backgroundColor') !== 'rgb(10, 20, 30)' && await page.evaluate(() => document.querySelectorAll('li').length === 3 && !!document.querySelector('span.label')), 'revert all restores page');
  await panel.locator('.snap-actions button', { hasText: 'Restore' }).click(); await settle(); await settle();
  assert(await css('.card', 'backgroundColor') === 'rgb(10, 20, 30)' && await page.evaluate(() => document.querySelectorAll('li').length === 2 && !!document.querySelector('button.label2')), 'snapshot restore re-applies everything');

  console.log('SPA navigation');
  await page.evaluate(() => history.pushState({}, '', '/other')); await page.waitForTimeout(1500);
  assert(await css('.card', 'backgroundColor') !== 'rgb(10, 20, 30)', 'edits for / are not applied on /other');
  await page.evaluate(() => history.pushState({}, '', '/')); await page.waitForTimeout(1500);
  assert(await css('.card', 'backgroundColor') === 'rgb(10, 20, 30)', 'edits re-applied when navigating back');

  // Send a request straight to the content script, as the panel does.
  const msg = (m) => panel.evaluate(([id, m]) => chrome.tabs.sendMessage(id, m), [tab.id, m]);
  const pageVal = (fn) => page.evaluate(fn);
  const ruleBlock = (selectorText) =>
    panel.locator('#styles .style-rule', { has: panel.locator('.rule-selector', { hasText: new RegExp(`^${selectorText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
  // The panel collapses its tree when the page navigates; re-open a path.
  const expand = async (...texts) => {
    for (const t of texts) {
      const toggle = row(t).locator('.tree-toggle.collapsed');
      if (await toggle.count()) { await toggle.click(); await settle(); }
    }
  };
  const propRow = (block, name) => block.locator('.prop-row', { has: panel.locator('.prop-name', { hasText: new RegExp(`^${name}$`) }) });

  console.log('duplicate a direct child of <body>');
  await expand('<body');
  await row('class="foot"').click({ button: 'right' }); await panel.locator('.ctx-item', { hasText: 'Duplicate element' }).click(); await settle();
  assert(await pageVal(() => document.querySelectorAll('footer.foot').length) === 2, 'footer duplicated');
  await pageVal(() => { document.getElementById('app').__mark = 1; });
  await page.waitForTimeout(3000);
  assert(await pageVal(() => document.getElementById('app').__mark === 1 && document.body.className === 'page'), 'body is not re-rendered by later re-applies');
  await panel.keyboard.press('Control+z'); await settle(); await settle();
  assert(await pageVal(() => document.querySelectorAll('footer.foot').length) === 1, 'undo removes the duplicate');

  console.log('Edit as HTML keeps <body> attributes');
  await row('<body').dblclick(); await panel.waitForSelector('.tree-edit-textarea');
  assert((await panel.locator('.tree-edit-textarea').inputValue()).startsWith('<body class="page">'), 'body editor shows its wrapper tag and attributes');
  await panel.keyboard.press('Escape');

  console.log('second HTML edit keeps the original for Revert');
  await msg({ type: 'APPLY_HTML', payload: { selector: { type: 'css', value: 'footer.foot' }, value: '<footer class="foot">Edit 1</footer>' } });
  const second = await msg({ type: 'APPLY_HTML', payload: { selector: { type: 'css', value: 'footer.foot' }, value: '<footer class="foot">Edit 2</footer>' } });
  assert(await pageVal(() => document.querySelector('footer.foot').textContent) === 'Edit 2', 'second edit applied');
  await msg({ type: 'REVERT_CHANGE', id: second.data.record.id }); await settle();
  assert(await pageVal(() => document.querySelector('footer.foot').textContent) === 'Foot', 'Revert returns to the page original, not the first edit');

  console.log('inline (xpath) styles');
  const titleXPath = { type: 'xpath', value: '//*[@id="title"]' };
  await msg({ type: 'APPLY_STYLE', payload: { selector: titleXPath, property: 'color', value: 'rgb(255, 0, 0)' } });
  assert(await css('#title', 'color') === 'rgb(255, 0, 0)', 'inline style applied');
  await msg({ type: 'APPLY_STYLE', payload: { selector: titleXPath, property: 'color', value: 'rgb(255, 0, 0)', disabled: true } });
  assert(await css('#title', 'color') === 'rgb(0, 128, 0)', 'disabling restores the page\'s own inline value');
  await msg({ type: 'APPLY_STYLE', payload: { selector: titleXPath, property: 'color', value: 'rgb(255, 0, 0)' } });
  await msg({ type: 'REVERT_PROP', selector: titleXPath.value, property: 'color' });
  assert(await pageVal(() => document.getElementById('title').style.color) === 'rgb(0, 128, 0)', 'revert restores the page\'s own inline value');

  console.log('SPA navigation takes the old route\'s edits back off');
  await msg({ type: 'APPLY_STYLE', payload: { selector: titleXPath, property: 'color', value: 'rgb(255, 0, 0)' } });
  await msg({ type: 'DELETE_ELEMENT', selector: { type: 'css', value: 'footer.foot' } }); await settle();
  assert(await pageVal(() => !document.querySelector('footer.foot')), 'footer deleted on /');
  await page.evaluate(() => history.pushState({}, '', '/other')); await page.waitForTimeout(1500);
  assert(await pageVal(() => !!document.querySelector('footer.foot')), 'deleted element is back on /other');
  assert(await css('#title', 'color') === 'rgb(0, 128, 0)', 'inline style removed on /other');
  await page.evaluate(() => history.pushState({}, '', '/')); await page.waitForTimeout(1500);
  assert(await pageVal(() => !document.querySelector('footer.foot')) && await css('#title', 'color') === 'rgb(255, 0, 0)', 'both re-applied back on /');

  console.log('unchecking an added property');
  await panel.locator('[data-tab="styles"]').click(); // the snapshot checks left another tab open
  await expand('<body', 'id="app"');
  await row('class="card"').click(); await settle();
  const elementStyle = ruleBlock('element.style');
  await elementStyle.locator('.prop-add').click();
  await panel.keyboard.type('color'); await panel.keyboard.press('Tab'); await panel.keyboard.type('rgb(200, 0, 0)'); await panel.keyboard.press('Enter'); await settle();
  assert(await css('.card', 'color') === 'rgb(200, 0, 0)', 'added color applied');
  await propRow(elementStyle, 'color').locator('.prop-checkbox').click(); await settle();
  assert(await css('.card', 'color') === 'rgb(0, 0, 255)', 'unchecking it falls back to the page\'s own color');

  console.log('typed !important and emptied values');
  await elementStyle.locator('.prop-add').click();
  await panel.keyboard.type('outline-style'); await panel.keyboard.press('Tab'); await panel.keyboard.type('dotted !important'); await panel.keyboard.press('Enter'); await settle();
  assert(await css('.card', 'outlineStyle') === 'dotted', 'a value typed with !important still applies');
  await propRow(elementStyle, 'outline-style').locator('.prop-value').click();
  await panel.keyboard.press('Control+a'); await panel.keyboard.press('Delete'); await panel.keyboard.press('Enter'); await settle();
  assert(await css('.card', 'outlineStyle') === 'none' && await propRow(elementStyle, 'outline-style').count() === 0, 'emptying an added value removes the property');

  console.log('rename a property, then Tab to its value');
  await expand('class="card"');
  await row('class="btn"').click(); await settle();
  await propRow(ruleBlock('.btn'), 'color').locator('.prop-name').click();
  await panel.keyboard.press('Control+a'); await panel.keyboard.type('background-color'); await panel.keyboard.press('Tab'); await settle();
  await panel.keyboard.type('rgb(0, 100, 0)'); await panel.keyboard.press('Enter'); await settle();
  assert(await css('.btn', 'backgroundColor') === 'rgb(0, 100, 0)', 'the value goes to the renamed property');
  assert(await css('.btn', 'color') !== 'rgb(0, 100, 0)', 'the old property is not overwritten');

  console.log('Revert all keeps what it cannot restore');
  await msg({ type: 'DELETE_ELEMENT', selector: { type: 'css', value: '#box > i.x' } }); await settle();
  await pageVal(() => document.getElementById('box').remove()); // the page re-renders the parent away
  await msg({ type: 'REVERT_ALL' }); await settle();
  const kept = (await msg({ type: 'GET_CHANGES' })).data.changes;
  assert(kept.length === 1 && kept[0].property === '__remove__', 'the unrestorable delete is kept; everything else is reverted');

  console.log('cascade strikethrough');
  await row('class="note"').click(); await settle();
  const noteColors = panel.locator('#styles .prop-row', { has: panel.locator('.prop-name', { hasText: /^color$/ }) });
  const struck = async (value) => (await noteColors.filter({ hasText: value }).first().getAttribute('class')).includes('overridden');
  assert(!(await struck('rgb(2, 2, 2)')), 'the later of two equal rules wins');
  assert(await struck('rgb(1, 1, 1)'), 'the earlier one is struck through');
  assert(!(await struck('rgb(3, 3, 3)')) && !(await struck('rgb(4, 4, 4)')), ':hover and ::before rules neither win nor lose');

  console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.join('\n') : '\nAll checks passed.');
  await ctx.close(); server.close();
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error(e.message); process.exit(1); });
