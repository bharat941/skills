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

const REPOINIT_CONFIG_RE = /^org\.apache\.sling\.jcr\.repoinit\.RepositoryInitializer(?:[~-][^/\\]+)?\.(?:cfg\.json|config|cfg)$/;

function isRepoInitConfigName(fileName) {
  if (typeof fileName !== 'string') return false;
  return REPOINIT_CONFIG_RE.test(path.basename(fileName));
}

function detectRunmode(fileAbs) {
  if (typeof fileAbs !== 'string') return null;
  const parent = path.basename(path.dirname(fileAbs));
  const match = parent.match(/^config(?:\.(.+))?$/);
  if (match) return match[1] || null;
  return null;
}

function decodeEscapes(value) {
  if (typeof value !== 'string') return '';
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char !== '\\' || i === value.length - 1) {
      out += char;
      continue;
    }
    const next = value[++i];
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else out += next;
  }
  return out;
}

function splitCsvList(raw) {
  return String(raw || '').split(',').map(part => part.trim()).filter(Boolean);
}

function parseFelixList(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  const body = trimmed.slice(1, -1);
  const values = [];
  let current = '';
  let quote = null;
  let escape = false;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (escape) {
      current += `\\${char}`;
      escape = false;
      continue;
    }
    if (char === '\\') {
      escape = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === '\'') {
      quote = char;
      continue;
    }
    if (char === ',') {
      const value = current.trim();
      if (value) values.push(decodeEscapes(value));
      current = '';
      continue;
    }
    current += char;
  }
  const last = current.trim();
  if (last) values.push(decodeEscapes(last));
  return values;
}

function parseKvConfig(text) {
  const result = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] === '#') continue;
    const equals = trimmed.indexOf('=');
    if (equals <= 0) continue;
    const key = trimmed.slice(0, equals).trim();
    const rawValue = trimmed.slice(equals + 1).trim();
    let values = parseFelixList(rawValue);
    if (values === null) values = [decodeEscapes(rawValue.replace(/^['"]|['"]$/g, ''))];
    if (!result[key]) result[key] = [];
    result[key].push.apply(result[key], values.filter(Boolean));
  }
  return result;
}

function toStringList(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string');
  return [];
}

function readRepoInitConfig(fileAbs, text) {
  const base = path.basename(String(fileAbs || ''));
  const runmode = detectRunmode(fileAbs);
  const output = { scripts: [], references: [], runmode, fatal: null };

  if (/\.cfg\.json$/.test(base)) {
    let parsed;
    try {
      parsed = JSON.parse(String(text || ''));
    } catch (error) {
      output.fatal = error && error.message ? error.message : 'invalid JSON';
      return output;
    }
    output.scripts = toStringList(parsed && parsed.scripts);
    output.references = toStringList(parsed && parsed.references);
    return output;
  }

  if (/\.config$/.test(base) || /\.cfg$/.test(base)) {
    const parsed = parseKvConfig(text);
    output.scripts = parsed.scripts || [];
    output.references = parsed.references || [];
  }
  return output;
}

function makeRepoInitUnknown(reason, scriptLine, runmode, policyPath, order) {
  return {
    kind: 'acl-unknown',
    sourceType: 'repoinit',
    policyPath: policyPath || null,
    order,
    effect: null,
    principals: [],
    privileges: [],
    restrictions: {},
    runmode: runmode || null,
    scriptLine,
    reason,
  };
}

function parseRestrictions(text) {
  const restrictions = {};
  let malformed = false;
  const stripped = text.replace(/\brestriction\s*\(([^)]*)\)/ig, (_, raw) => {
    const items = splitCsvList(raw);
    const name = items.shift();
    if (!name) {
      malformed = true;
      return ' ';
    }
    if (!restrictions[name]) restrictions[name] = [];
    restrictions[name].push.apply(restrictions[name], items);
    return ' ';
  });
  return { restrictions, malformed, stripped };
}

function parseAceClauses(text) {
  const clauses = { privileges: '', on: null, for: null };
  const stripped = String(text || '').trim();
  const lower = stripped.toLowerCase();
  let cursor = 0;
  let firstClause = stripped.length;
  for (const keyword of [' on ', ' for ']) {
    const idx = lower.indexOf(keyword);
    if (idx >= 0 && idx < firstClause) firstClause = idx;
  }
  clauses.privileges = stripped.slice(0, firstClause).trim();
  cursor = firstClause;
  while (cursor < stripped.length) {
    while (cursor < stripped.length && /\s/.test(stripped[cursor])) cursor++;
    if (cursor >= stripped.length) break;
    let keyword = null;
    if (lower.slice(cursor, cursor + 3) === 'on ') keyword = 'on';
    if (lower.slice(cursor, cursor + 4) === 'for ') keyword = 'for';
    if (!keyword) break;
    cursor += keyword.length + 1;
    let next = stripped.length;
    for (const marker of [' on ', ' for ']) {
      const idx = lower.indexOf(marker, cursor);
      if (idx >= 0 && idx < next) next = idx;
    }
    clauses[keyword] = stripped.slice(cursor, next).trim();
    cursor = next;
  }
  return clauses;
}

function parseRepoInit(text, options) {
  const runmode = options && options.runmode ? options.runmode : null;
  const lines = String(text || '').split(/\r?\n/);
  const entries = [];
  let order = 0;
  let block = null;

  for (let idx = 0; idx < lines.length; idx++) {
    const scriptLine = idx + 1;
    const rawLine = lines[idx];
    const line = rawLine.trim();
    if (!line || line[0] === '#') continue;

    if (!block) {
      const forMatch = line.match(/^set\s+ACL\s+for\s+(.+)$/i);
      if (forMatch) {
        block = {
          type: 'for',
          principals: splitCsvList(forMatch[1]),
          startLine: scriptLine,
          startIndex: entries.length,
        };
        continue;
      }
      const onMatch = line.match(/^set\s+ACL\s+on\s+(.+)$/i);
      if (onMatch) {
        block = {
          type: 'on',
          paths: splitCsvList(onMatch[1]),
          startLine: scriptLine,
          startIndex: entries.length,
        };
        continue;
      }
      if (/^set\s+principal\s+ACL\b/i.test(line)) {
        entries.push(makeRepoInitUnknown('principal-based RepoInit ACL is out of scope', scriptLine, runmode, null, order++));
        block = { type: 'principal', startLine: scriptLine, startIndex: entries.length - 1 };
      }
      continue;
    }

    if (/^end$/i.test(line)) {
      block = null;
      continue;
    }

    if (block.type === 'principal') continue;
    const aceMatch = line.match(/^(allow|deny)\s+(.+)$/i);
    if (!aceMatch) {
      entries.push(makeRepoInitUnknown(`unrecognized RepoInit ACL line: ${line}`, scriptLine, runmode, block.type === 'on' ? (block.paths[0] || null) : null, order++));
      continue;
    }
    const effect = aceMatch[1].toLowerCase();
    const rest = aceMatch[2];
    const restrictionParse = parseRestrictions(rest);
    if (restrictionParse.malformed) {
      entries.push(makeRepoInitUnknown(`unrecognized RepoInit ACL line: ${line}`, scriptLine, runmode, null, order++));
      continue;
    }
    const clauses = parseAceClauses(restrictionParse.stripped);
    const privileges = splitCsvList(clauses.privileges);
    const policyPaths = clauses.on ? splitCsvList(clauses.on) : (block.type === 'on' ? block.paths : []);
    const principals = clauses.for ? splitCsvList(clauses.for) : (block.type === 'for' ? block.principals : []);
    if (!privileges.length || !policyPaths.length || !principals.length) {
      entries.push(makeRepoInitUnknown(`unrecognized RepoInit ACL line: ${line}`, scriptLine, runmode, null, order++));
      continue;
    }

    for (const policyPath of policyPaths) {
      if (!policyPath.startsWith('/') || /^home\s*\(/i.test(policyPath) || policyPath === ':repository') {
        entries.push(makeRepoInitUnknown(`unrecognized RepoInit ACL line: ${line}`, scriptLine, runmode, null, order++));
        continue;
      }
      entries.push({
        kind: 'acl-entry',
        sourceType: 'repoinit',
        policyPath,
        order: order++,
        effect,
        principals,
        privileges,
        restrictions: restrictionParse.restrictions,
        runmode,
        scriptLine,
      });
    }
  }

  if (block) {
    if (typeof block.startIndex === 'number') entries.splice(block.startIndex);
    entries.push(makeRepoInitUnknown('unterminated RepoInit ACL block', block.startLine, runmode, null, order++));
  }
  return { entries };
}

function validateMigrationPaths(paths) {
  const values = paths === undefined ? [] : paths;
  if (!Array.isArray(values)) {
    throw new TypeError('Invalid --migration-path value: expected an absolute JCR path such as --migration-path /content/site (no "..", "//", or wildcards *?[]).');
  }
  return values.map(value => {
    if (value === undefined || value === null) {
      throw new TypeError('Missing value: --migration-path requires a value, e.g. --migration-path /content/site.');
    }
    const raw = String(value);
    const segments = raw.split('/');
    const valid = raw.startsWith('/')
      && !raw.includes('//')
      && !/[?*[\]]/.test(raw)
      && !segments.includes('..')
      && !segments.includes('.');
    if (!valid) {
      throw new TypeError(`Invalid --migration-path "${raw}": expected an absolute JCR path such as --migration-path /content/site (no "..", "//", or wildcards *?[]).`);
    }
    const normalized = raw === '/' ? '/' : raw.replace(/\/+$/, '');
    return normalized || '/';
  });
}

function isJcrAncestor(ancestor, candidate) {
  if (ancestor === '/') return candidate.startsWith('/');
  return candidate === ancestor || candidate.startsWith(`${ancestor}/`);
}

function relationTo(policyPath, migrationPaths) {
  if (policyPath === null || policyPath === undefined) return { relation: null, matchedPaths: [] };
  if (!migrationPaths || migrationPaths.length === 0) return { relation: 'unscoped', matchedPaths: [] };
  const paths = migrationPaths.map(value => value === '/' ? '/' : String(value).replace(/\/+$/, ''));
  const matchedPaths = paths.filter(migrationPath =>
    isJcrAncestor(policyPath, migrationPath) || isJcrAncestor(migrationPath, policyPath)
  );
  if (paths.includes(policyPath)) return { relation: 'self', matchedPaths };
  if (matchedPaths.some(migrationPath => isJcrAncestor(policyPath, migrationPath))) {
    return { relation: 'ancestor', matchedPaths };
  }
  if (matchedPaths.length) return { relation: 'descendant', matchedPaths };
  return { relation: 'unrelated', matchedPaths: [] };
}

function aceSeverity(entry) {
  if (entry.relation === 'ancestor' || entry.status === 'unknown' || entry.kind === 'acl-unknown') return 'high';
  if (['acl-clear-review', 'not-eligible-for-acl-import', 'unknown'].includes(entry.importVerdict)) return 'high';
  return 'medium';
}

function formatAceDetail(entry) {
  const subject = entry.policyPath || entry.file || 'file';
  if (entry.kind === 'acl-unknown' || entry.status === 'unknown') {
    return `${subject} UNKNOWN — ${entry.reason || 'unclassified ACL entry'}`;
  }
  let relation;
  if (entry.relation === 'self') {
    relation = `self ${entry.matchedPaths && entry.matchedPaths.join(', ') || entry.policyPath}`;
  } else if (entry.relation === 'ancestor') {
    relation = `ancestor of ${entry.matchedPaths && entry.matchedPaths.join(', ')} — potentially relevant (inherited)`;
  } else if (entry.relation === 'descendant') {
    relation = `descendant of ${entry.matchedPaths && entry.matchedPaths.join(', ')}`;
  } else if (entry.relation === 'unscoped') {
    relation = 'unscoped';
  } else {
    relation = 'path unresolved';
  }
  const principals = (entry.principals || []).join(',');
  const privileges = (entry.privileges || []).join(',');
  const restrictions = Object.keys(entry.restrictions || {}).map(name =>
    `${name}=[${entry.restrictions[name].join(',')}]`
  ).join('; ');
  const effect = entry.effect || 'UNKNOWN';
  const importValue = entry.importVerdict || 'unknown';
  if (entry.sourceType === 'repoinit') {
    return `${subject} [${relation}] ${effect} ${principals} ${privileges} restrictions{${restrictions}} | runmode: ${entry.runmode || 'any'} | import: ${importValue}`;
  }
  return `${subject} [${relation}] ${effect} ${principals} ${privileges} restrictions{${restrictions}} | filter: ${entry.filterStatus || 'unknown'} | acHandling: ${entry.acHandling || 'unknown'} | import: ${importValue}`;
}

function workspaceRelative(root, fileAbs) {
  return path.relative(root, fileAbs).split(path.sep).join('/');
}

function hasJcrRootSegment(fileAbs, root) {
  return path.relative(root, fileAbs).split(path.sep).includes('jcr_root');
}

function jcrPathForFile(fileAbs, root) {
  const relativeSegments = path.relative(root, fileAbs).split(path.sep);
  let jcrRootIndex = -1;
  for (let i = relativeSegments.length - 1; i >= 0; i--) {
    if (relativeSegments[i] === 'jcr_root') {
      jcrRootIndex = i;
      break;
    }
  }
  if (jcrRootIndex < 0) return null;
  const nodeSegments = relativeSegments.slice(jcrRootIndex + 1);
  nodeSegments.pop();
  return decodeFileVaultPath(nodeSegments);
}

function makeReferenceUnknown(reason, context) {
  return {
    kind: 'acl-unknown',
    sourceType: 'repoinit',
    policyPath: null,
    order: 0,
    effect: null,
    principals: [],
    privileges: [],
    restrictions: {},
    runmode: context.runmode || null,
    scriptIndex: context.scriptIndex,
    reason,
  };
}

function runAclScan(workspaceRoot, options) {
  const root = path.resolve(String(workspaceRoot || ''));
  const migrationPaths = validateMigrationPaths(options && options.migrationPaths);
  const result = {
    ok: true,
    findings: [],
    rawFindings: [],
    warnings: [],
    scanStatus: 'complete',
    unreadable: [],
  };
  let rootStat;
  try {
    rootStat = fs.statSync(root);
    if (!rootStat.isDirectory()) throw new Error('not a directory');
  } catch (error) {
    result.ok = false;
    result.scanStatus = 'incomplete';
    result.error = `ACL scan workspace root could not be read: ${error.message}`;
    return result;
  }

  const files = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      result.unreadable.push(workspaceRelative(root, dir));
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'target', 'dist'].includes(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const fileAbs = path.join(dir, entry.name);
        const relative = workspaceRelative(root, fileAbs);
        if (isRepoInitConfigName(entry.name)) {
          files.push({ fileAbs, relative, type: 'repoinit' });
        } else if (entry.name === '_rep_policy.xml' && hasJcrRootSegment(fileAbs, root)) {
          files.push({ fileAbs, relative, type: 'policy-xml' });
        } else if (entry.name === '.content.xml' && hasJcrRootSegment(fileAbs, root)) {
          files.push({ fileAbs, relative, type: 'content-xml' });
        }
      }
    }
  }
  walk(root);

  const entries = [];
  function addEntry(entry, fileAbs, fileRelative, sourceType, extra) {
    const base = Object.assign({}, entry, extra || {});
    base.file = fileRelative;
    if (base.line === undefined && base.scriptLine !== undefined) base.line = base.scriptLine;
    if (base.line === undefined || base.line === null) base.line = 1;
    base.sourceType = sourceType || base.sourceType;
    if (base.sourceType === 'repoinit') {
      base.filterStatus = null;
      base.acHandling = null;
      base.importVerdict = base.kind === 'acl-unknown' ? 'unknown' : 'repoinit-defined';
    } else {
      const packageInfo = resolvePackage(fileAbs, base.policyPath, root);
      base.filterStatus = packageInfo.filterStatus;
      base.acHandling = packageInfo.acHandling;
      base.importVerdict = base.kind === 'acl-unknown' ? 'unknown' : packageInfo.importVerdict;
    }
    const relation = relationTo(base.policyPath, migrationPaths);
    base.relation = relation.relation;
    base.matchedPaths = relation.matchedPaths;
    if (relation.relation === 'unrelated') {
      result.skippedCount = (result.skippedCount || 0) + 1;
      return;
    }
    base.status = base.kind === 'acl-unknown' ? 'unknown' : 'complete';
    base.severity = aceSeverity(base);
    entries.push(base);
  }

  function parseScript(text, fileAbs, fileRelative, runmode, scriptIndex, sourceFileIsConfig) {
    const parsed = parseRepoInit(text, { runmode });
    for (const entry of parsed.entries) {
      addEntry(entry, fileAbs, fileRelative, 'repoinit', {
        line: entry.scriptLine,
        scriptIndex: sourceFileIsConfig ? scriptIndex : undefined,
      });
    }
  }

  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file.fileAbs, 'utf8');
    } catch (_) {
      result.unreadable.push(file.relative);
      continue;
    }
    if (file.type === 'policy-xml') {
      const policyPath = jcrPathForFile(file.fileAbs, root);
      const parsed = parsePolicyXml(text, { nodePath: policyPath });
      if (parsed.fatal) {
        const malformed = {
          kind: 'acl-unknown',
          sourceType: 'policy-xml',
          policyPath,
          reason: `malformed: ${parsed.fatal}`,
          order: 0,
          line: 1,
        };
        addEntry(malformed, file.fileAbs, file.relative, 'policy-xml');
        result.warnings.push(`ACL file could not be parsed: ${file.relative} — ${parsed.fatal}`);
      } else {
        for (const entry of parsed.entries) addEntry(entry, file.fileAbs, file.relative, 'policy-xml');
      }
    } else if (file.type === 'content-xml') {
      if (!text.includes('rep:policy')) continue;
      const nodePath = jcrPathForFile(file.fileAbs, root);
      const parsed = parsePolicyXml(text, { nodePath, inline: true });
      if (parsed.fatal) {
        const malformed = {
          kind: 'acl-unknown',
          sourceType: 'inline-policy',
          policyPath: nodePath,
          reason: `malformed: ${parsed.fatal}`,
          order: 0,
          line: 1,
        };
        addEntry(malformed, file.fileAbs, file.relative, 'inline-policy');
        result.warnings.push(`ACL file could not be parsed: ${file.relative} — ${parsed.fatal}`);
      } else {
        for (const entry of parsed.entries) addEntry(entry, file.fileAbs, file.relative, 'inline-policy');
      }
    } else {
      const config = readRepoInitConfig(file.fileAbs, text);
      if (config.fatal) {
        addEntry(makeReferenceUnknown(`malformed RepoInit config: ${config.fatal}`, {
          runmode: config.runmode, scriptIndex: 0,
        }), file.fileAbs, file.relative, 'repoinit', { line: 1, scriptIndex: 0 });
      }
      config.scripts.forEach((script, scriptIndex) => parseScript(
        script, file.fileAbs, file.relative, config.runmode, scriptIndex, true
      ));
      for (const reference of config.references) {
        const prefix = 'file:';
        let referencePath = null;
        if (reference.startsWith(prefix)) {
          const rel = reference.slice(prefix.length);
          const candidate = path.resolve(root, rel);
          if (rel && !path.isAbsolute(rel) && isWithin(root, candidate)) referencePath = candidate;
        }
        let referencedText;
        if (referencePath) {
          try {
            const realRoot = fs.realpathSync(root);
            const realReference = fs.realpathSync(referencePath);
            if (isWithin(realRoot, realReference) && fs.statSync(realReference).isFile()) {
              try {
                referencedText = fs.readFileSync(realReference, 'utf8');
              } catch (_) {
                result.unreadable.push(workspaceRelative(root, referencePath));
              }
            }
          } catch (_) {
            referencedText = undefined;
          }
        }
        if (referencedText === undefined) {
          const unknown = makeReferenceUnknown(`unresolved RepoInit reference: ${reference}`, {
            runmode: config.runmode,
          });
          addEntry(unknown, file.fileAbs, file.relative, 'repoinit', { line: 1 });
          continue;
        }
        parseScript(referencedText, referencePath, workspaceRelative(root, referencePath), config.runmode, 0, false);
      }
    }
  }

  if (!migrationPaths.length) {
    result.warnings.push('No --migration-path given: ACL entries are reported unscoped and inheritance relevance was not assessed. Re-run with --migration-path <jcrPath> (repeatable) for each migration-set path.');
  } else if (result.skippedCount) {
    result.warnings.push(`${result.skippedCount} ACL entries outside the migration paths were skipped.`);
  }
  result.unreadable = Array.from(new Set(result.unreadable)).sort();
  if (result.unreadable.length) {
    result.scanStatus = 'incomplete';
    result.warnings.push(`ACL scan incomplete: ${result.unreadable.length} file(s) could not be read: ${result.unreadable.join(', ')}`);
  }

  entries.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.order - b.order);
  for (const entry of entries) {
    const configLocation = entry.sourceType === 'repoinit' && entry.scriptIndex !== undefined
      && (entry.file.endsWith('.cfg.json') || entry.file.endsWith('.config') || entry.file.endsWith('.cfg'));
    const location = configLocation
      ? `${entry.file} (scripts[${entry.scriptIndex}]:${entry.line})`
      : `${entry.file}:${entry.line}`;
    result.rawFindings.push({
      pattern: 'aclPermissions',
      snippet: null,
      ...entry,
    });
    result.findings.push({
      location,
      detail: formatAceDetail(entry),
      severity: entry.severity,
    });
  }
  delete result.skippedCount;
  return result;
}

module.exports = {
  decodeFileVaultPath,
  parseFileVaultValue,
  parsePolicyXml,
  resolvePackage,
  importVerdict,
  isRepoInitConfigName,
  readRepoInitConfig,
  parseRepoInit,
  validateMigrationPaths,
  relationTo,
  aceSeverity,
  formatAceDetail,
  runAclScan,
};
