import test from 'node:test';
import assert from 'node:assert/strict';
import { searchField, isArticle, QUERY, ARTICLE_PATH, recordWikipedia } from '../scripts/wikipedia-scenario.mjs';
const field = (type, text, box = { x: 50, y: 20, width: 200, height: 30 }) => ({ tag: 'input', type, text, box });
const initial = { url: 'https://en.wikipedia.org/wiki/Main_Page', title: 'Wikipedia', viewport: { width: 1280, height: 800 }, elements: [field('checkbox', ''), field('search', 'Search Wikipedia')] };

test('search target excludes the menu checkbox and offscreen search inputs', () => {
  const offscreen = field('search', 'Search Wikipedia', { x: 50, y: -20, width: 100, height: 10 });
  assert.equal(searchField({ ...initial, elements: [initial.elements[0], offscreen, initial.elements[1]] }), initial.elements[1]);
});

test('home page, search results, and the playwright occupation cannot pass article acceptance', () => {
  for (const path of ['/wiki/Main_Page', '/w/index.php?search=Playwright', '/wiki/Playwright']) {
    assert.equal(isArticle({ url: 'https://en.wikipedia.org' + path, title: QUERY }), false);
  }
  assert.equal(isArticle({ url: 'https://en.wikipedia.org' + ARTICLE_PATH, title: QUERY + ' - Wikipedia' }), true);
});

test('typing uses the focused search field and verifies the query before submitting', async () => {
  const calls = [];
  let typed = false, submitted = false;
  const driver = {
    getState: async () => submitted ? { ...initial, url: 'https://en.wikipedia.org' + ARTICLE_PATH, title: QUERY + ' - Wikipedia' }
      : typed ? { ...initial, elements: [field('search', QUERY)] } : initial,
    click: async (x, y) => calls.push(['click', x, y]),
    type: async (text) => { calls.push(['type', text]); typed = true; },
    keypress: async (key) => { assert.ok(typed); submitted = true; calls.push(['press', key]); },
    page: { waitForURL: async () => {}, locator: () => ({ innerText: async () => QUERY }) },
  };
  let captures = 0;
  await recordWikipedia(driver, async () => captures++);
  assert.deepEqual(calls, [['click', 150, 35], ['type', QUERY], ['press', 'Enter']]);
  assert.equal(captures, 4);
});
