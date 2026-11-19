'use strict';
const fs = require('fs');
const path = require('path');

function decodeFileVaultPath(segments) {
  if (!Array.isArray(segments)) return null;
  const decoded = [];
  for (const segment of segments) {
    if (typeof segment !== 'string') return null;
    let name = '';
    let source = segment;
    let namespaceSeparator = false;
    if (source.startsWith('_') && !source.startsWith('__')) {
      source = source.slice(1);
      namespaceSeparator = true;
    }
    for (let i = 0; i < source.length; i++) {
      if (source[i] === '_' && source[i + 1] === '_') {
        name += '_';
        i++;
      } else if (source[i] === '_' && namespaceSeparator) {
        name += ':';
        namespaceSeparator = false;
      } else {
        name += source[i];
      }
    }
    try {
      decoded.push(decodeURIComponent(name));
    } catch (_) {
      return null;
    }
  }
  return `/${decoded.join('/')}`;
}

function parseFileVaultValue(raw) {
  if (typeof raw !== 'string') return null;
  const typed = raw.replace(/^\{[^}]*\}/, '');
  let bracketDepth = 0;
  for (const char of typed) {
    if (char === '[') bracketDepth++;
    if (char === ']') {
      bracketDepth--;
      if (bracketDepth < 0) return null;
    }
  }
  if (bracketDepth !== 0) return null;
  const bracketed = typed.startsWith('[');
  if (bracketed && !typed.endsWith(']')) return null;
  const value = bracketed ? typed.slice(1, -1) : typed;
  if (bracketed && value === '') return [];
  const values = [];
  let current = '';
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '\\') {
      const next = value[i + 1];
      if (next === ',' || next === '\\') {
        current += next;
        i++;
      } else {
        current += char;
      }
    } else if (char === ',') {
      if (!bracketed) return [typed];
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function decodeXmlAttribute(value) {
  let invalid = false;
  const decoded = value.replace(/&([^;]+);/g, (entity, name) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.prototype.hasOwnProperty.call(named, name)) return named[name];
    let codePoint;
    if (/^#\d+$/.test(name)) codePoint = Number(name.slice(1));
    else if (/^#x[\da-f]+$/i.test(name)) codePoint = parseInt(name.slice(2), 16);
    else {
      invalid = true;
      return entity;
    }
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      invalid = true;
      return entity;
    }
    return String.fromCodePoint(codePoint);
  });
  return invalid ? null : decoded;
}

function tokenizeXml(text) {
  const document = { name: null, attrs: {}, children: [], line: 1 };
  const stack = [document];
  let cursor = 0;
  let roots = 0;
  const fatal = message => ({ document: null, fatal: message });

  function addText(start, end) {
    if (stack.length === 1 && text.slice(start, end).trim()) return false;
    return true;
  }

  while (cursor < text.length) {
    const start = text.indexOf('<', cursor);
    if (start === -1) {
      if (!addText(cursor, text.length)) return fatal('text outside the XML root');
      cursor = text.length;
      break;
    }
    if (!addText(cursor, start)) return fatal('text outside the XML root');
    if (text.startsWith('<!--', start)) {
      const end = text.indexOf('-->', start + 4);
      if (end === -1) return fatal('unclosed XML comment');
      cursor = end + 3;
      continue;
    }
    if (text.startsWith('<?', start)) {
      const end = text.indexOf('?>', start + 2);
      if (end === -1) return fatal('unclosed processing instruction');
      cursor = end + 2;
      continue;
    }

    let end = start + 1;
    let quote = null;
    for (; end < text.length; end++) {
      const char = text[end];
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        break;
      }
    }
    if (end === text.length || quote) return fatal('unclosed XML tag');

    const body = text.slice(start + 1, end);
    const line = text.slice(0, start).split('\n').length;
    if (body[0] === '/') {
      const match = body.match(/^\/\s*([A-Za-z_][\w:.-]*)\s*$/);
      if (!match) return fatal('malformed XML end tag');
      if (stack.length === 1 || stack[stack.length - 1].name !== match[1]) return fatal(`mismatched XML end tag ${match[1]}`);
      stack.pop();
      cursor = end + 1;
      continue;
    }

    const selfClosing = /\/\s*$/.test(body);
    const content = selfClosing ? body.replace(/\/\s*$/, '') : body;
    const nameMatch = content.match(/^\s*([A-Za-z_][\w:.-]*)([\s\S]*)$/);
    if (!nameMatch) return fatal('stray or malformed < in XML');
    const name = nameMatch[1];
    const attrText = nameMatch[2];
    const attrs = {};
    let offset = 0;
    while (offset < attrText.length) {
      const whitespace = attrText.slice(offset).match(/^\s+/);
      if (whitespace) offset += whitespace[0].length;
      else if (offset > 0) return fatal(`attributes on ${name} are not separated`);
      if (offset >= attrText.length) break;
      const attrMatch = attrText.slice(offset).match(/^([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/);
      if (!attrMatch) return fatal(`malformed XML attribute on ${name}`);
      const attrName = attrMatch[1];
      if (Object.prototype.hasOwnProperty.call(attrs, attrName)) return fatal(`duplicate XML attribute ${attrName}`);
      const decoded = decodeXmlAttribute(attrMatch[3] === undefined ? attrMatch[4] : attrMatch[3]);
      if (decoded === null) return fatal(`invalid XML entity in ${attrName}`);
      attrs[attrName] = decoded;
      offset += attrMatch[0].length;
    }

    const node = { name, attrs, children: [], line };
    if (stack.length === 1) {
      roots++;
      if (roots > 1) return fatal('multiple XML roots');
    }
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    cursor = end + 1;
  }
  if (stack.length !== 1) return fatal(`unclosed XML tag ${stack[stack.length - 1].name}`);
  if (roots !== 1) return fatal('missing XML root');
  return { document, fatal: null };
}

function makeUnknown(reason, context) {
  return {
    kind: 'acl-unknown',
    sourceType: context.sourceType,
    policyPath: context.policyPath,
    order: context.order,
    effect: null,
    principals: [],
    privileges: [],
    restrictions: {},
    line: context.line,
    reason,
  };
}

function joinPolicyPath(nodePath, segments) {
  if (typeof nodePath !== 'string' || !nodePath.startsWith('/')) return null;
  const suffix = decodeFileVaultPath(segments);
  if (suffix === null) return null;
  const base = nodePath.replace(/\/+$/, '');
  if (suffix === '/') return base || '/';
  return `${base}${suffix}` || suffix;
}

function entriesForPolicy(policy, policyPath, sourceType) {
  if (policy.attrs['jcr:primaryType'] !== 'rep:ACL') {
    return [makeUnknown(sourceType === 'inline-policy' ? 'rep:policy is not rep:ACL' : 'root is not rep:ACL', {
      sourceType, policyPath, order: 0, line: policy.line,
    })];
  }
  const entries = [];
  policy.children.forEach((ace, order) => {
    const context = { sourceType, policyPath, order, line: ace.line };
    const type = ace.attrs['jcr:primaryType'];
    const effect = type === 'rep:GrantACE' ? 'allow' : type === 'rep:DenyACE' ? 'deny' : null;
    if (!effect) {
      entries.push(makeUnknown(`unexpected ACE type ${type || '(missing)'}`, context));
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(ace.attrs, 'rep:principalName')) {
      entries.push(makeUnknown('missing rep:principalName', context));
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(ace.attrs, 'rep:privileges')) {
      entries.push(makeUnknown('missing rep:privileges', context));
      return;
    }

    const principals = parseFileVaultValue(ace.attrs['rep:principalName']);
    const privileges = parseFileVaultValue(ace.attrs['rep:privileges']);
    if (principals === null || privileges === null) {
      entries.push(makeUnknown('could not decode rep:principalName or rep:privileges', context));
      return;
    }
    const restrictions = {};
    let invalidRestriction = false;
    function addRestriction(name, value) {
      const parsed = parseFileVaultValue(value);
      if (parsed === null) {
        invalidRestriction = true;
        return;
      }
      if (!restrictions[name]) restrictions[name] = [];
      restrictions[name].push(...parsed);
    }
    for (const [name, value] of Object.entries(ace.attrs)) {
      if (name === 'jcr:primaryType' || name === 'rep:principalName' || name === 'rep:privileges' || name === 'xmlns' || name.startsWith('xmlns:')) continue;
      addRestriction(name, value);
    }
    for (const child of ace.children) {
      if (child.name !== 'rep:restrictions') continue;
      for (const [name, value] of Object.entries(child.attrs)) {
        if (name !== 'jcr:primaryType') addRestriction(name, value);
      }
    }
    if (invalidRestriction) {
      entries.push(makeUnknown('could not decode restriction value', context));
      return;
    }
    entries.push({
      kind: 'acl-entry',
      sourceType,
      policyPath,
      order,
      effect,
      principals,
      privileges,
      restrictions,
      line: ace.line,
    });
  });
  return entries;
}

function parsePolicyXml(text, options) {
  const sourceType = options && options.inline ? 'inline-policy' : 'policy-xml';
  const { document, fatal } = tokenizeXml(String(text));
  if (fatal) return { entries: [], fatal };
  const root = document.children[0];
  if (sourceType === 'policy-xml') {
    return { entries: entriesForPolicy(root, options ? options.nodePath : null, sourceType), fatal: null };
  }

  const entries = [];
  function visit(node, segments) {
    for (const child of node.children) {
      if (child.name === 'rep:policy') {
        const policyPath = joinPolicyPath(options ? options.nodePath : null, segments);
        entries.push(...entriesForPolicy(child, policyPath, sourceType));
      } else {
        const decoded = decodeFileVaultPath([child.name]);
        visit(child, decoded === null ? segments.concat(child.name) : segments.concat(decoded.slice(1)));
      }
    }
  }
  visit(root, []);
  return { entries, fatal: null };
}

function isWithin(base, candidate) {
  const rel = path.relative(base, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function findPackageRoot(fileAbs, workspaceRoot) {
  if (typeof fileAbs !== 'string' || typeof workspaceRoot !== 'string') return null;
  const workspace = path.resolve(workspaceRoot);
  let cursor = path.resolve(fileAbs);
  if (!isWithin(workspace, cursor)) return null;
  try {
    if (fs.statSync(cursor).isFile()) cursor = path.dirname(cursor);
  } catch (_) {
    cursor = path.dirname(cursor);
  }
  while (isWithin(workspace, cursor)) {
    const hasJcrRoot = fs.existsSync(path.join(cursor, 'src/main/content/jcr_root'));
    const hasVault = fs.existsSync(path.join(cursor, 'META-INF/vault'));
    if (hasJcrRoot && hasVault) return cursor;
    if (cursor === workspace) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

function normalizeAcHandling(raw) {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  const known = new Set(['ignore', 'overwrite', 'merge', 'merge_preserve', 'clear', 'not-set']);
  return known.has(normalized) ? normalized : 'unknown';
}

function readPropertiesAcHandling(packageRoot) {
  const propertiesPath = path.join(packageRoot, 'META-INF/vault/properties.xml');
  if (!fs.existsSync(propertiesPath)) return null;
  let xml;
  try {
    xml = fs.readFileSync(propertiesPath, 'utf8');
  } catch (_) {
    return 'unknown';
  }
  const { document, fatal } = tokenizeXml(xml);
  if (fatal) return 'unknown';
  function find(node) {
    for (const child of node.children || []) {
      if (child.name === 'entry' && child.attrs && child.attrs.key === 'acHandling') {
        return normalizeAcHandling(child.children && child.children.length ? '' : child.attrs.value || '');
      }
      const nested = find(child);
      if (nested !== null) return nested;
    }
    return null;
  }
  const fromAttr = find(document);
  if (fromAttr !== null) return fromAttr;
  const textMatch = xml.match(/<\s*entry\b[^>]*\bkey\s*=\s*(['"])acHandling\1[^>]*>([\s\S]*?)<\s*\/\s*entry\s*>/i);
  if (!textMatch) return null;
  const decoded = decodeXmlAttribute(textMatch[2].trim());
  if (decoded === null) return 'unknown';
  return normalizeAcHandling(decoded);
}

function readPomAcHandling(packageRoot, workspaceRoot) {
  const workspace = path.resolve(workspaceRoot);
  let cursor = packageRoot;
  while (isWithin(workspace, cursor)) {
    const pomPath = path.join(cursor, 'pom.xml');
    if (fs.existsSync(pomPath)) {
      let text = '';
      try {
        text = fs.readFileSync(pomPath, 'utf8');
      } catch (_) {
        return 'unknown';
      }
      const accessMatch = text.match(/<\s*accessControlHandling\s*>([\s\S]*?)<\s*\/\s*accessControlHandling\s*>/i);
      const aliasMatch = text.match(/<\s*acHandling\s*>([\s\S]*?)<\s*\/\s*acHandling\s*>/i);
      const match = accessMatch || aliasMatch;
      if (!match) return null;
      return normalizeAcHandling(match[1]);
    }
    if (cursor === workspace) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

function evaluateFilterCoverage(filterXml, policyPath) {
  if (!policyPath || typeof policyPath !== 'string' || !policyPath.startsWith('/')) return 'unknown';
  const normalizedPolicy = policyPath === '/' ? '/' : policyPath.replace(/\/+$/, '') || '/';
  const target = normalizedPolicy === '/' ? '/rep:policy' : `${normalizedPolicy}/rep:policy`;
  const { document, fatal } = tokenizeXml(filterXml);
  if (fatal) return 'unknown';
  const filters = [];
  function collect(node) {
    for (const child of node.children || []) {
      if (child.name === 'filter') {
        const root = child.attrs && typeof child.attrs.root === 'string' ? child.attrs.root : null;
        if (!root || !root.startsWith('/')) return false;
        const rules = [];
        for (const rule of child.children || []) {
          if (rule.name === 'include' || rule.name === 'exclude') {
            const pattern = rule.attrs && rule.attrs.pattern;
            if (typeof pattern !== 'string') return false;
            rules.push({ type: rule.name, pattern });
          }
        }
        filters.push({ root, rules });
      }
      if (!collect(child)) return false;
    }
    return true;
  }
  if (!collect(document)) return 'unknown';
  let covered = false;
  for (const filter of filters) {
    const applies = target === filter.root || target.startsWith(filter.root === '/' ? '/' : `${filter.root}/`);
    if (!applies) continue;
    let included = true;
    if (filter.rules.length > 0) {
      included = filter.rules[0].type === 'exclude';
      for (const rule of filter.rules) {
        let re;
        try {
          re = new RegExp(`^(?:${rule.pattern})$`);
        } catch (_) {
          return 'unknown';
        }
        if (re.test(target)) included = rule.type === 'include';
      }
    }
    if (included) {
      covered = true;
      break;
    }
  }
  return covered ? 'covered' : 'not-covered';
}

function importVerdict(filterStatus, acHandling) {
  if (acHandling === 'clear') return 'acl-clear-review';
  if (filterStatus === 'not-covered') return 'not-eligible-for-acl-import';
  if (acHandling === 'ignore') return 'not-eligible-for-acl-import';
  if (filterStatus === 'covered' && (acHandling === 'overwrite' || acHandling === 'merge' || acHandling === 'merge_preserve')) {
    return 'eligible-for-acl-import';
  }
  return 'unknown';
}

function resolvePackage(fileAbs, policyPath, workspaceRoot) {
  const packageRoot = findPackageRoot(fileAbs, workspaceRoot);
  if (!packageRoot) {
    return {
      packageRoot: null,
      filterStatus: 'unknown',
      acHandling: 'unknown',
      importVerdict: 'unknown',
    };
  }

  const filterPath = path.join(packageRoot, 'META-INF/vault/filter.xml');
  let filterStatus = 'unknown';
  if (fs.existsSync(filterPath)) {
    try {
      filterStatus = evaluateFilterCoverage(fs.readFileSync(filterPath, 'utf8'), policyPath);
    } catch (_) {
      filterStatus = 'unknown';
    }
  }

  let acHandling = readPropertiesAcHandling(packageRoot);
  if (acHandling === null) acHandling = readPomAcHandling(packageRoot, workspaceRoot);
  if (acHandling === null) acHandling = 'not-set';

  return {
    packageRoot,
    filterStatus,
    acHandling,
    importVerdict: importVerdict(filterStatus, acHandling),
  };
}

module.exports = { decodeFileVaultPath, parseFileVaultValue, parsePolicyXml, resolvePackage, importVerdict };
