/** Scripted Wikipedia search recorded through the shipped browser driver. */
export const QUERY = 'Playwright (software)';
export const ARTICLE_PATH = '/wiki/Playwright_(software)';

/**
 * Select a visible text search field, excluding menu and appearance inputs.
 * @param state - BrowserDriver page state.
 * @returns the visible search field, or undefined while it is unavailable.
 */
export function searchField(state) {
  return state.elements.find((element) => element.tag === 'input'
    && ['search', 'text'].includes(element.type)
    && /search/i.test(element.text)
    && element.box.x >= 0 && element.box.y >= 0
    && element.box.x + element.box.width <= state.viewport.width
    && element.box.y + element.box.height <= state.viewport.height);
}

/**
 * Match the software article by URL and title.
 * @param state - BrowserDriver page state.
 * @returns whether navigation reached the expected article.
 */
export function isArticle(state) {
  return new URL(state.url).pathname === ARTICLE_PATH && state.title.includes(QUERY);
}

async function until(driver, predicate, description) {
  const deadline = Date.now() + 30000;
  do {
    const state = await driver.getState();
    if (predicate(state)) return state;
    await driver.wait(200);
  } while (Date.now() < deadline);
  throw new Error(`Wikipedia demo did not reach ${description}`);
}

/**
 * Record initial page, focused search, verified input, and the resulting article.
 * @param driver - Isolated shipped browser driver, already on Wikipedia.
 * @param capture - Save one screenshot from this recording run.
 * @returns completion after the destination URL and heading pass validation.
 */
export async function recordWikipedia(driver, capture) {
  const initial = await until(driver, (state) => Boolean(searchField(state)), 'a visible search field');
  await capture();
  const field = searchField(initial);
  await driver.click(Math.round(field.box.x + field.box.width / 2), Math.round(field.box.y + field.box.height / 2));
  await capture();
  await driver.type(QUERY);
  await until(driver, (state) => state.elements.some((element) => element.tag === 'input'
    && ['search', 'text'].includes(element.type) && element.text === QUERY), 'the entered query');
  await capture();
  await Promise.all([
    driver.page.waitForURL((url) => url.pathname === ARTICLE_PATH, { waitUntil: 'domcontentloaded', timeout: 30000 }),
    driver.keypress('Enter'),
  ]);
  const result = await until(driver, isArticle, 'the Playwright software article');
  const heading = await driver.page.locator('h1').innerText();
  if (heading !== QUERY) throw new Error(`Unexpected article heading: ${heading}`);
  await capture();
  console.log(JSON.stringify({ query: QUERY, url: result.url, title: result.title, heading, verified: true }));
}
