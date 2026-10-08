'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { discoverTemplates, assertSafeOptions, runTemplateProbe } = require('./template-runtime.js');

const TEMPLATE = '/conf/wknd/settings/wcm/templates/content-page-template';
const args = { sdkUrl: 'http://localhost:4502', user: 'admin', password: 'admin', template: TEMPLATE,
  contentParent: '/content/wknd/validation', allowContentWrite: 'true' };

test('discovers and selects editable templates from a content package', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'template-validation-'));
  try {
    const entry = path.join(dir, 'jcr_root', TEMPLATE.slice(1), '.content.xml');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '<jcr:root/>');
    execFileSync('zip', ['-q', '-r', 'package.zip', 'jcr_root'], { cwd: dir });
    assert.deepEqual(discoverTemplates(path.join(dir, 'package.zip')), [TEMPLATE]);
    assert.deepEqual(discoverTemplates(path.join(dir, 'package.zip'), TEMPLATE), [TEMPLATE]);
    assert.deepEqual(discoverTemplates(path.join(dir, 'package.zip'), TEMPLATE.replace('content-page', 'other')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rejects unapproved parent and non-local SDK', () => {
  assert.throws(() => assertSafeOptions({ ...args, allowContentWrite: undefined }), /allow-content-write/);
  assert.throws(() => assertSafeOptions({ ...args, contentParent: '/content/wknd' }), /content-parent/);
  assert.throws(() => assertSafeOptions({ ...args, sdkUrl: 'https://remote.example' }), /local isolated SDK/);
});

function stubSdk({ render = true, deleteOk = true, createOk = true } = {}) {
  const requests = [];
  let created = false;
  let savedTitle;
  global.fetch = async (url, options = {}) => {
    const p = new URL(url).pathname;
    requests.push({ p, method: options.method || 'GET' });
    let status = 200;
    let body = {};
    if (p === '/libs/granite/csrf/token.json') body = { token: 'csrf' };
    else if (p === '/bin/wcmcommand') { created = createOk; status = createOk ? 200 : 500; }
    else if (p.endsWith('/jcr:content.json')) {
      if (!created) status = 404;
      else body = { 'cq:template': TEMPLATE, 'jcr:title': savedTitle || 'initial' };
    } else if (p.endsWith('/jcr:content/root.json')) body = { 'sling:resourceType': 'wknd/components/container' };
    else if (p.endsWith('/jcr:content')) savedTitle = new URLSearchParams(options.body).get('jcr:title');
    else if (p.endsWith('.html')) { body = render ? savedTitle || '' : ''; }
    else if (p.endsWith('.json') && p.includes('validate-template-')) status = created ? 200 : 404;
    else if (p.includes('validate-template-') && options.method === 'POST') { if (deleteOk) created = false; }
    return { ok: status >= 200 && status < 300, status,
      json: async () => body,
      text: async () => typeof body === 'string' ? body : JSON.stringify(body) };
  };
  return requests;
}

test('creates, reopens, renders and deletes one disposable page', async () => {
  const oldFetch = global.fetch;
  try {
    const requests = stubSdk();
    const result = await runTemplateProbe(args);
    assert.equal(result.result, 'pass');
    assert.equal(result.checks.cleanup, true);
    assert.equal(result.restricted, true);
    assert.ok(requests.some((r) => r.p === '/bin/wcmcommand' && r.method === 'POST'));
    assert.ok(requests.some((r) => r.p.includes('validate-template-') && r.method === 'POST'));
  } finally { global.fetch = oldFetch; }
});

test('reports failures separately and flags an orphan when cleanup fails', async () => {  const oldFetch = global.fetch;
  try {
    stubSdk({ render: false, deleteOk: false });
    const result = await runTemplateProbe(args);
    assert.equal(result.result, 'fail');
    assert.equal(result.checks.cleanup, false);
    assert.match(result.evidence, /cleanup failed/);
    stubSdk({ createOk: false });
    const rejected = await runTemplateProbe(args);
    assert.equal(rejected.result, 'fail');
    assert.equal(rejected.checks.page_created, false);
  } finally { global.fetch = oldFetch; }
});

test('verify emits independent payloads and reports for two templates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'template-reports-'));
  try {
    const state = path.join(dir, '.validate-migration');
    fs.mkdirSync(state);
    fs.writeFileSync(path.join(state, 'state.json'), JSON.stringify({ prepared: [TEMPLATE, TEMPLATE.replace('content-page', 'article-page')].map((template) => ({
      pattern: 'custom-templates', discovered: { template }, failure: {
        result: 'fail', failure_class: 'deploy.failed', evidence: 'test fixture', verification_level: 'runtime',
      },
    })) }));
    const execution = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'check.js'), '--stage', 'verify', '--project', dir, '--project-id', 'test-project'], { encoding: 'utf8' });
    assert.equal(execution.status, 1, execution.stderr);
    const payloads = [...execution.stdout.matchAll(/=== report-migration-outcome payload ===\n([^\n]+)/g)].map((m) => JSON.parse(m[1]));
    assert.equal(payloads.length, 2);
    assert.notEqual(payloads[0].run_id, payloads[1].run_id);
    assert.equal(payloads[0].skill_pattern, 'custom-templates');
    assert.equal(payloads[0].summary.classes_total, 1);
    assert.equal(fs.readdirSync(state).filter((file) => /^rvc-\d+\.json$/.test(file)).length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('names the missing page component when ui.apps is not deployed', async () => {
  const oldFetch = global.fetch;
  try {
    let created = false, savedTitle;
    global.fetch = async (url, options = {}) => {
      const p = new URL(url).pathname;
      let status = 200, body = {};
      if (p === '/libs/granite/csrf/token.json') body = { token: 'csrf' };
      else if (p === '/bin/wcmcommand') created = true;
      else if (p.endsWith('/jcr:content.json')) body = created ? { 'cq:template': TEMPLATE, 'sling:resourceType': 'wknd/components/page', 'jcr:title': savedTitle } : (status = 404, {});
      else if (p.endsWith('/jcr:content/root.json')) body = { 'sling:resourceType': 'wknd/components/container' };
      else if (p.endsWith('/jcr:content')) savedTitle = new URLSearchParams(options.body).get('jcr:title');
      else if (p.endsWith('.html')) body = '<!--cq{"decorated":false}-->';
      else if (p.startsWith('/apps/wknd/components/page')) status = 404;
      else if (p.endsWith('.json') && p.includes('validate-template-')) status = created ? 200 : 404;
      else if (options.method === 'POST' && new URLSearchParams(options.body).get(':operation') === 'delete') created = false;
      return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => typeof body === 'string' ? body : JSON.stringify(body) };
    };
    const result = await runTemplateProbe(args);
    assert.equal(result.result, 'fail');
    assert.match(result.evidence, /not deployed \(ui\.apps missing\)/);
  } finally { global.fetch = oldFetch; }
});

test('findReactorRoot walks up to the aggregator pom', () => {
  const { findReactorRoot } = require('./check.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reactor-'));
  try {
    fs.writeFileSync(path.join(dir, 'pom.xml'), '<project><packaging>pom</packaging></project>');
    const mod = path.join(dir, 'ui.content');
    fs.mkdirSync(mod);
    fs.writeFileSync(path.join(mod, 'pom.xml'), '<project><packaging>content-package</packaging></project>');
    assert.equal(findReactorRoot(mod), dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
