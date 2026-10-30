import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DesktopDriver, DaemonClient } from '../drivers/desktop.js';
import { fileURLToPath } from 'node:url';
const helper = fileURLToPath(new URL('../native/macos-helper', import.meta.url));

test('desktop screenshots require a selected application', async () => {
  const driver = new DesktopDriver();
  driver.permissionsChecked = true;
  try { await assert.rejects(driver.screenshot(), { code: 'TARGET_REQUIRED' }); }
  finally { await driver.close(); }
});

test('native helper rejects missing and vanished targets without a screenshot', { skip: process.platform !== 'darwin' }, () => {
  for (const [args, code] of [[{}, 'TARGET_REQUIRED'], [{ pid: -1 }, 'WINDOW_NOT_FOUND']]) {
    const result = JSON.parse(execFileSync(helper, ['screenshot', JSON.stringify(args)], { encoding: 'utf8', timeout: 15000 }));
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(result.path, undefined);
  }
});

test('daemon closes only after helper exit and can start a new helper', { skip: process.platform !== 'darwin' }, async () => {
  const daemon = new DaemonClient(helper);
  try {
    assert.equal((await daemon.call('permissions')).ok, true);
    const child = daemon.proc;
    await daemon.close();
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(daemon.pending.length, 0);
    assert.equal((await daemon.call('permissions')).ok, true);
    assert.notEqual(daemon.proc, child);
  } finally { await daemon.close(); }
});
