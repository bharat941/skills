'use strict';

/** Disposable editable-template page probe. Only runs on an explicitly approved local SDK. */
const { execFileSync } = require('child_process');
const { FAILURE_CLASSES } = require('./failure-classes.js');

const TEMPLATE_PREFIX = /^\/conf\/[a-zA-Z0-9_-]+\/settings\/wcm\/templates\/[a-zA-Z0-9_-]+$/;
const CONTENT_PARENT = /^\/content\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/;

function discoverTemplates(artifactPath, selected) {
  const entries = execFileSync('unzip', ['-Z1', artifactPath], { encoding: 'utf8' });
  const templates = [...new Set([...entries.matchAll(/(?:^|\n)(?:jcr_root\/)?(conf\/[^/\s]+\/settings\/wcm\/templates\/[^/\s]+)\/\.content\.xml(?=\n|$)/g)]
    .map((m) => '/' + m[1]))].sort();
  if (selected && !TEMPLATE_PREFIX.test(selected)) throw new Error('Invalid --template: expected /conf/<site>/settings/wcm/templates/<name>');
  return selected ? templates.filter((p) => p === selected) : templates;
}

function assertSafeOptions({ sdkUrl, contentParent, allowContentWrite }) {
  const url = new URL(sdkUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Template testing requires a local isolated SDK; remote SDKs are not supported.');
  }
  if (allowContentWrite !== 'true' || !CONTENT_PARENT.test(contentParent || '') || contentParent.split('/').length < 4) {
    throw new Error('Template testing requires --allow-content-write true and an approved existing --content-parent under /content/<site>/<test-area>.');
  }
}

async function request(sdkUrl, pathname, options, auth) {
  const response = await fetch(new URL(pathname, sdkUrl), {
    redirect: 'manual',
    ...options,
    headers: { Authorization: `Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString('base64')}`, ...options?.headers },
  });
  return response;
}

async function runTemplateProbe({ sdkUrl, user, password, template, contentParent, allowContentWrite, authoringContainer, authoringResourceType }) {
  assertSafeOptions({ sdkUrl, contentParent, allowContentWrite });
  if (!TEMPLATE_PREFIX.test(template)) throw new Error('Invalid editable template path');
  if ((authoringContainer || authoringResourceType) && !(authoringContainer && authoringResourceType)) {
    throw new Error('Pass both --authoring-container and --authoring-resource-type to test body authoring.');
  }
  if (authoringContainer && !/^root(?:\/[a-zA-Z0-9_-]+)+$/.test(authoringContainer)) {
    throw new Error('Invalid --authoring-container: expected a path below root.');
  }
  if (authoringResourceType && !/^[a-zA-Z0-9_./-]+$/.test(authoringResourceType)) {
    throw new Error('Invalid --authoring-resource-type.');
  }
  const auth = { user, password };
  const parent = await request(sdkUrl, `${contentParent}.json`, {}, auth);
  if (!parent.ok) throw new Error(`Test parent ${contentParent} is not accessible (HTTP ${parent.status}); no content was created.`);
  const suffix = `validate-template-${Date.now()}-${require('crypto').randomBytes(4).toString('hex')}`;
  const page = `${contentParent}/${suffix}`;
  const marker = `Template validation ${suffix}`;
  let created = false;
  const checks = { page_created: false, template_reference: false, template_structure: false, authoring_persisted: false, renders: false, cleanup: false, policy_authoring: 'not_verified' };
  let failure;
  try {
    const tokenResponse = await request(sdkUrl, '/libs/granite/csrf/token.json', {}, auth);
    if (!tokenResponse.ok) throw new Error(`CSRF token unavailable (HTTP ${tokenResponse.status})`);
    const token = (await tokenResponse.json()).token;
    if (!token) throw new Error('CSRF token response contains no token');
    const headers = { 'X-CSRF-Token': token, 'Content-Type': 'application/x-www-form-urlencoded' };
    const params = new URLSearchParams({ cmd: 'createPage', parentPath: contentParent, label: suffix, title: marker, template });
    // WCM createPage applies the template's initial and structure content. Sling POST
    // creation with cq:template alone would not exercise page creation from a template.
    const create = await request(sdkUrl, '/bin/wcmcommand', { method: 'POST', headers, body: params }, auth);
    if (!create.ok && create.status !== 302) throw new Error(`WCM page creation failed (HTTP ${create.status})`);
    const pageResponse = await request(sdkUrl, `${page}/jcr:content.json`, {}, auth);
    if (!pageResponse.ok) throw new Error(`Created page not readable (HTTP ${pageResponse.status})`);
    created = true;
    const data = await pageResponse.json();
    checks.page_created = true;
    checks.template_reference = data['cq:template'] === template;
    if (!checks.template_reference) throw new Error(`Created page does not reference ${template}`);
    const rootResponse = await request(sdkUrl, `${page}/jcr:content/root.json`, {}, auth);
    if (!rootResponse.ok) throw new Error(`Template root structure missing (HTTP ${rootResponse.status})`);
    const root = await rootResponse.json();
    checks.template_structure = Boolean(root['sling:resourceType']);
    if (!checks.template_structure) throw new Error('Template root structure lacks a resource type');

    // Author a disposable page property and re-fetch it. Body component authoring
    // is opt-in because the component and editable container differ per template.
    const target = authoringContainer ? `${page}/jcr:content/${authoringContainer}/validation-text` : `${page}/jcr:content`;
    const body = new URLSearchParams(authoringContainer
      ? { 'jcr:primaryType': 'nt:unstructured', 'sling:resourceType': authoringResourceType, text: marker }
      : { 'jcr:title': marker + ' updated' });
    const save = await request(sdkUrl, target, { method: 'POST', headers, body }, auth);
    if (!save.ok && save.status !== 302) throw new Error(`Page authoring failed (HTTP ${save.status})`);
    const reopened = await request(sdkUrl, `${target}.json`, {}, auth);
    if (!reopened.ok) throw new Error(`Authored content not readable (HTTP ${reopened.status})`);
    const saved = await reopened.json();
    checks.authoring_persisted = authoringContainer ? saved.text === marker && saved['sling:resourceType'] === authoringResourceType : saved['jcr:title'] === marker + ' updated';
    if (!checks.authoring_persisted) throw new Error('Authored content did not persist on reopen');
    const rendered = await request(sdkUrl, `${page}.html`, {}, auth);
    const html = await rendered.text();
    checks.renders = rendered.ok && html.includes(marker);
    if (!checks.renders) {
      // An empty body with only a cq debug comment means the page component's
      // HTL (ui.apps) is not deployed — the app build/deploy is incomplete.
      const pageComponent = data['sling:resourceType'];
      const componentMissing = /^<!--cq\{/.test(html.trim()) || html.length < 400;
      if (componentMissing && pageComponent) {
        const resolved = await request(sdkUrl, `/apps/${pageComponent}.json`, {}, auth).catch(() => null);
        if (!resolved || resolved.status === 404) {
          throw new Error(`page component '${pageComponent}' is not deployed (ui.apps missing) — install the full app package, then re-validate`);
        }
      }
      throw new Error(`Page render did not contain saved content (HTTP ${rendered.status})`);
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    // Delete only the uniquely generated page; never touch templates or existing pages.
    const exists = await request(sdkUrl, `${page}.json`, {}, auth).catch(() => null);
    if (exists?.ok) {
      created = true;
      try {
        const tokenResponse = await request(sdkUrl, '/libs/granite/csrf/token.json', {}, auth);
        const token = (await tokenResponse.json()).token;
        const remove = await request(sdkUrl, page, { method: 'POST', headers: { 'X-CSRF-Token': token, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ':operation': 'delete' }) }, auth);
        // Deletion is not instantaneous; poll for the node to disappear.
        let gone = false;
        for (let attempt = 0; attempt < 5 && !gone; attempt++) {
          const after = await request(sdkUrl, `${page}.json`, {}, auth);
          if (after.status === 404) { gone = true; break; }
          await new Promise((r) => setTimeout(r, 400));
        }
        checks.cleanup = (remove.ok || remove.status === 302) && gone;
      } catch { checks.cleanup = false; }
    } else {
      checks.cleanup = !created;
    }
    if (!checks.cleanup) failure = `${failure ? failure + '; ' : ''}cleanup failed: inspect disposable page ${page}`;
  }
  return {
    result: failure ? 'fail' : 'pass',
    ...(failure ? { failure_class: FAILURE_CLASSES.CONTRACT_MISMATCH, evidence: `${template}: ${failure}` } : {}),
    checks: { ...checks, test_page: page, ...(authoringContainer ? { body_component: authoringResourceType } : { body_component: 'not_tested' }) },
    restricted: true,
    restricted_reason: authoringContainer ? 'Sling POST does not prove the AEM editor enforces the template component policy' : 'Body component and AEM editor policy were not tested',
    template,
  };
}

module.exports = { discoverTemplates, assertSafeOptions, runTemplateProbe };
