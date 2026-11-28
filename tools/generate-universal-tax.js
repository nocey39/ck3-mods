#!/usr/bin/env node
'use strict';

// Load-time adapter, not an engine-level final-tax override. No dependencies.
// Reads game + enabled mods, writes only the requested output directory.
// node generate-universal-tax.js --game <game> [--user-dir <CK3 user>] --output <adapter>
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const PUBLIC = 'teq_public_tax_obligation';
const LEVEL = 'teq_public_tax_standard';
const FLAG = 'teq_public_tax_contract';
const GENERATOR = 'teq-universal-public-tax';
const PREDICATE = 'teq_public_contract_active';
const ROOT = 'common/subject_contracts';
const FILES = {
  contracts: ROOT + '/contracts/zzzz_teq_universal_tax_contracts.txt',
  groups: ROOT + '/groups/zzzz_teq_universal_tax_groups.txt',
};
const SELF_FILES = new Set(['zz_teq_vassal_tax_contracts.txt', 'zz_teq_public_tax_factors.txt', ...Object.values(FILES).map(p => path.posix.basename(p))]);
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const plain = raw => raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(["\\])/g, '$1') : raw;
const virtual = value => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

function lex(source) {
  const pattern = /"(?:\\.|[^"\\])*"|#[^\r\n]*|\?=|>=|<=|!=|[{}=<>]|[^\s{}=<>!?"#\uFEFF]+/g;
  return [...source.matchAll(pattern)].filter(m => !m[0].startsWith('#')).map(m => ({ raw: m[0], start: m.index, end: m.index + m[0].length }));
}

function parse(source, label = 'source') {
  const tokens = lex(source);
  let i = 0;
  function entries(nested) {
    const out = [];
    while (i < tokens.length && tokens[i].raw !== '}') {
      const token = tokens[i++];
      if (!['=', '?=', '<', '<=', '>', '>=', '!='].includes(tokens[i]?.raw)) {
        assert.notEqual(token.raw, '{', `${label}: anonymous nested blocks are unsupported at this position`);
        out.push({ key: null, value: token.raw, start: token.start, end: token.end });
        continue;
      }
      const op = tokens[i++].raw;
      const first = tokens[i++];
      assert(first && first.raw !== '}', `${label}: missing value for ${token.raw}`);
      const entry = { key: token.raw, op, start: token.start, valueStart: first.start };
      if (first.raw === '{') {
        entry.value = entries(true);
        const close = tokens[i++];
        assert.equal(close?.raw, '}', `${label}: unclosed ${token.raw}`);
        entry.close = close.start;
        entry.valueEnd = close.end;
      } else entry.value = first.raw, entry.valueEnd = first.end;
      entry.end = entry.valueEnd;
      out.push(entry);
    }
    assert(!nested || tokens[i]?.raw === '}', `${label}: unclosed block`);
    return out;
  }
  const ast = entries(false);
  assert.equal(i, tokens.length, `${label}: unexpected closing brace`);
  return ast;
}

function edits(source, replacements) {
  const sorted = [...replacements].sort((a, b) => b.start - a.start);
  let nextStart = source.length;
  for (const r of sorted) {
    assert(r.end <= nextStart && r.start <= r.end, 'Overlapping source edits');
    source = source.slice(0, r.start) + r.text + source.slice(r.end);
    nextStart = r.start;
  }
  return source;
}

function walk(dir, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en')).flatMap(entry => {
    const relative = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symbolic link in contract input requires explicit resolution: ${relative}`);
    return entry.isDirectory() ? walk(path.join(dir, entry.name), relative) : [relative];
  });
}

function descriptor(file, userDir) {
  const source = fs.readFileSync(file, 'utf8');
  const ast = parse(source, 'mod descriptor');
  const last = key => ast.filter(e => e.key === key).at(-1)?.value;
  assert(!last('archive'), 'Archive mods require extraction before generating this adapter');
  const rawPath = last('path');
  assert(typeof rawPath === 'string', 'Enabled mod descriptor has no directory path');
  const directory = plain(rawPath);
  const root = path.isAbsolute(directory) ? directory : path.resolve(userDir, directory);
  assert(fs.existsSync(root) && fs.statSync(root).isDirectory(), 'Enabled mod directory does not exist');
  return { root, remoteId: last('remote_file_id') ? plain(last('remote_file_id')) : null,
    replacePaths: ast.filter(e => e.key === 'replace_path').map(e => {
      assert.equal(typeof e.value, 'string', 'replace_path must be a string');
      const p = virtual(plain(e.value));
      assert(!p.split('/').includes('..') && !/^[a-z]:/i.test(p), 'replace_path must be a virtual relative path');
      return p;
    }), descriptorHash: sha(source) };
}

function layersFor(game, userDir, output) {
  const layers = [{ id: 'game', root: game, replacePaths: [] }];
  const excluded = [];
  if (!userDir) return { layers, excluded };
  const load = JSON.parse(fs.readFileSync(path.join(userDir, 'dlc_load.json'), 'utf8'));
  assert(Array.isArray(load.enabled_mods), 'dlc_load.json must contain enabled_mods');
  load.enabled_mods.forEach((entry, index) => {
    assert.equal(typeof entry, 'string', 'enabled_mods entries must be descriptor paths');
    const file = path.isAbsolute(entry) ? entry : path.resolve(userDir, entry);
    const mod = descriptor(file, userDir);
    const label = `mod:${index + 1}:${path.basename(entry)}`;
    const priorManifest = path.join(mod.root, 'manifest.json');
    let generatedAdapter = false;
    if (fs.existsSync(priorManifest)) {
      try {
        const metadata = JSON.parse(fs.readFileSync(priorManifest, 'utf8'));
        generatedAdapter = metadata.generator === GENERATOR || (
          metadata.policy?.publicContract === PUBLIC && metadata.policy?.requiredReplacePath === ROOT &&
          Object.values(FILES).every(p => metadata.outputs?.some(f => f.path === p)));
      } catch { /* An unrelated manifest is not evidence that this is a TEQ adapter. */ }
    }
    if (mod.remoteId === '3839551460' || path.resolve(mod.root) === output || generatedAdapter) {
      excluded.push({ source: label, descriptorHash: mod.descriptorHash, reason: 'TEQ itself or this generated output; do not adapt an earlier adapter' });
      return;
    }
    layers.push({ ...mod, id: label });
  });
  return { layers, excluded };
}

function effectiveFiles(layers) {
  const files = new Map();
  const skipped = [];
  for (const layer of layers) {
    for (const replace of layer.replacePaths) {
      for (const key of files.keys()) if (key === replace || key.startsWith(replace + '/')) files.delete(key);
    }
      for (const relative of walk(path.join(layer.root, ROOT))) {
        const key = `${ROOT}/${relative}`;
        const first = relative.split('/')[0];
        const kind = relative.toLowerCase().endsWith('.txt') && ['contracts', 'groups'].includes(first) ? first : 'opaque';
        const buffer = fs.readFileSync(path.join(layer.root, key));
        const record = { path: key, source: layer.id, hash: sha(buffer), kind, buffer, text: kind === 'opaque' ? null : buffer.toString('utf8') };
        if (SELF_FILES.has(path.posix.basename(key))) {
          skipped.push({ path: key, source: layer.id, hash: record.hash, reason: 'previous TEQ tax adapter' });
          continue;
        }
        files.set(key, record);
      }
  }
  return { files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path, 'en')), skipped };
}

function inlineVariables(source, variables, label) {
  const resolve = (name, seen = new Set()) => {
    assert(variables.has(name), `${label}: undefined file-local variable ${name}`);
    assert(!seen.has(name), `${label}: cyclic file-local variable ${name}`);
    const value = variables.get(name);
    assert.equal(typeof value, 'string', `${label}: non-scalar file-local variable ${name}`);
    return value.startsWith('@') ? resolve(value, new Set([...seen, name])) : value;
  };
  return edits(source, lex(source).filter(t => t.raw.startsWith('@')).map(t => ({ start: t.start, end: t.end, text: resolve(t.raw) })));
}

function definitionsFrom(files) {
  const definitions = { contracts: new Map(), groups: new Map() };
  const shadowed = [];
  for (const file of files) {
    if (file.kind === 'opaque') continue;
    const ast = parse(file.text, file.path);
    const variables = new Map(ast.filter(e => e.key?.startsWith('@')).map(e => [e.key, e.value]));
    for (const entry of ast) {
      assert(entry.key && entry.op === '=', `${file.path}: database entries must be named assignments`);
      if (entry.key.startsWith('@')) continue;
      assert(Array.isArray(entry.value), `${file.path}: database definition ${entry.key} must be a block`);
      const raw = inlineVariables(file.text.slice(entry.start, entry.end), variables, file.path);
      const record = { name: plain(entry.key), text: raw, path: file.path, source: file.source, fileHash: file.hash, definitionHash: sha(raw) };
      const previous = definitions[file.kind].get(record.name);
      if (previous) shadowed.push({ kind: file.kind, name: record.name, earlier: { source: previous.source, path: previous.path }, winner: { source: record.source, path: record.path } });
      definitions[file.kind].set(record.name, record);
    }
  }
  return { definitions, shadowed };
}

function scalar(entry, message) {
  assert(entry && typeof entry.value === 'string', message);
  return plain(entry.value);
}

function groupInfo(record) {
  const ast = parse(record.text, record.name)[0];
  const tributaryFields = ast.value.filter(e => e.key === 'is_tributary');
  const isTributary = tributaryFields.length ? scalar(tributaryFields.at(-1), 'is_tributary must be scalar') : 'no';
  assert(['yes', 'no'].includes(isTributary), `${record.name}: unsupported dynamic is_tributary`);
  const lists = ast.value.filter(e => e.key === 'contracts');
  assert(lists.length <= 1, `${record.name}: repeated contracts lists need explicit engine semantics`);
  const list = lists[0];
  assert(!list || Array.isArray(list.value), `${record.name}: contracts must be a list`);
  const members = list ? list.value.map(e => { assert.equal(e.key, null, `${record.name}: contract references must be bare list members`); return plain(e.value); }) : [];
  const admin = ast.value.find(e => e.key === 'admin_province_contract');
  return { ast, list, members, implicit: admin ? [scalar(admin, 'admin_province_contract must be scalar')] : [], tributary: isTributary === 'yes' };
}

function appendPublic(record, info) {
  assert(!info.members.includes(PUBLIC), `${record.name}: input already contains the generated public obligation`);
  const insert = info.list ? info.list.close : info.ast.close;
  const value = info.list ? `\n\t\t${PUBLIC}\n\t` : `\n\tcontracts = { ${PUBLIC} }\n`;
  return edits(record.text, [{ start: insert, end: insert, text: value }]);
}

function wrapContract(record) {
  const ast = parse(record.text, record.name)[0];
  const replacements = [], fields = [];
  for (const levels of ast.value.filter(e => e.key === 'obligation_levels')) {
    assert(Array.isArray(levels.value), `${record.name}: obligation_levels must be a block`);
    for (const level of levels.value) {
      assert(level.key && Array.isArray(level.value), `${record.name}: obligation level must be named`);
      for (const field of level.value.filter(e => ['tax', 'min_tax', 'tax_factor'].includes(e.key))) {
        const inactive = Array.isArray(field.value)
          ? record.text.slice(field.valueStart + 1, field.valueEnd - 1)
          : `value = ${field.value}`;
        replacements.push({ start: field.valueStart, end: field.valueEnd, text: `{\n\t\t\t\tif = { limit = { ${PREDICATE} = yes } value = 0 }\n\t\t\t\telse = {${inactive}\n\t\t\t\t}\n\t\t\t}` });
        fields.push({ level: plain(level.key), field: field.key });
      }
    }
  }
  return { text: edits(record.text, replacements), fields };
}

function canonical(text) {
  // Whitespace inside quoted script literals is data, not formatting.
  const strings = lex(text).filter(t => t.raw.startsWith('"'));
  const replacements = [];
  let stringIndex = 0;
  for (const match of text.matchAll(/[\t ]+(?=\r?$)|\r(?=\n)/gm)) {
    while (strings[stringIndex]?.end <= match.index) stringIndex++;
    const string = strings[stringIndex];
    if (string && string.start <= match.index && match.index < string.end) continue;
    replacements.push({ start: match.index, end: match.index + match[0].length, text: '' });
  }
  return edits(text, replacements).trimEnd() + '\n';
}

function generate({ game, userDir, output }) {
  game = path.resolve(game); output = path.resolve(output);
  if (userDir) userDir = path.resolve(userDir);
  assert(fs.existsSync(path.join(game, ROOT)), '--game must point to a CK3 game directory');
  assert(output !== game && (!userDir || output !== userDir), 'Output must be a separate generated adapter directory');
  const { layers, excluded } = layersFor(game, userDir, output);
  for (const layer of layers) {
    const relative = path.relative(layer.root, output);
    assert(relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative), 'Output must not be inside a native/mod source directory');
  }
  const { files, skipped } = effectiveFiles(layers);
  const { definitions, shadowed } = definitionsFrom(files);
  assert(!definitions.contracts.has(PUBLIC), 'Input contract name collides with the reserved public obligation');
  const groupRecords = [], activeContracts = new Set();
  for (const record of definitions.groups.values()) {
    const info = groupInfo(record);
    if (!info.tributary) {
      for (const name of [...info.members, ...info.implicit]) {
        assert(definitions.contracts.has(name), `${record.name}: referenced contract ${name} is missing after overlays/replace_path`);
        activeContracts.add(name);
      }
    }
    groupRecords.push({ record, info, text: info.tributary ? record.text : appendPublic(record, info) });
  }
  const contracts = [...definitions.contracts.values()].map(record => {
    const wrapped = activeContracts.has(record.name) ? wrapContract(record) : { text: record.text, fields: [] };
    return { record, ...wrapped };
  });
  const publicDefinition = `${PUBLIC} = {\n\tdisplay_mode = hidden\n\tcan_be_changed = { always = no }\n\tobligation_levels = {\n\t\t${LEVEL} = {\n\t\t\tdefault = yes\n\t\t\tflag = ${FLAG}\n\t\t\tai_liege_desire = 0\n\t\t\tai_subject_desire = 0\n\t\t\tscore = 0\n\t\t\ttax = { if = { limit = { ${PREDICATE} = yes } value = 1 } else = { value = 0 } }\n\t\t\tmin_tax = { if = { limit = { ${PREDICATE} = yes } value = 1 } else = { value = 0 } }\n\t\t}\n\t}\n}`;
  const header = '# Generated from the effective game/mod contract database. Regenerate after changing mods or load order.\n# Predicate implementation belongs to TEQ. Use this complete database as the final subject_contracts replacement layer.\n\n';
  const outputs = {
    ...Object.fromEntries(files.filter(f => f.kind === 'opaque').map(f => [f.path, f.buffer])),
    [FILES.contracts]: canonical(header + [publicDefinition, ...contracts.map(c => c.text)].join('\n\n')),
    [FILES.groups]: canonical(header + groupRecords.map(g => g.text).join('\n\n')),
  };
  const sourceInfo = r => ({ source: r.source, path: r.path, fileHash: r.fileHash, definitionHash: r.definitionHash });
  const manifest = {
    schema: 1, generator: GENERATOR,
    policy: { publicContract: PUBLIC, publicLevel: LEVEL, publicFlag: FLAG, predicate: PREDICATE, activeOriginalFinance: 0, activePublicTax: 1,
      requiredReplacePath: ROOT, requiredPosition: 'after every adapted mod',
      regeneration: 'Required when enabled mods, their contents, the game version or load order change. This is a load-time adapter, not a runtime universal override.',
      personalIncome: 'No salary, domicile or income-source modifier is changed; final engine taxable-income exclusions require in-game validation.' },
    precedence: 'Apply replace_path and same-virtual-file overlays in enabled_mods order; parse remaining virtual paths in lexical order; the last named definition wins.',
    sources: layers.map(l => ({ id: l.id, descriptorHash: l.descriptorHash || null, replacePaths: l.replacePaths })),
    effectiveFiles: files.map(({ path, source, hash, kind }) => ({ path, source, hash, kind })),
    excludedSources: excluded, excludedAdapterFiles: skipped, shadowedDefinitions: shadowed,
    groups: groupRecords.map(({ record, info }) => ({ name: record.name, tributary: info.tributary, adapted: !info.tributary, contracts: info.members, ...sourceInfo(record) })),
    contracts: contracts.map(({ record, fields }) => ({ name: record.name, adapted: activeContracts.has(record.name), financeFields: fields, ...sourceInfo(record) })),
    outputs: Object.entries(outputs).map(([path, contents]) => ({ path, hash: sha(contents) })),
    counts: { groups: groupRecords.length, nonTributaryGroups: groupRecords.filter(g => !g.info.tributary).length,
      contracts: contracts.length, adaptedContracts: activeContracts.size, wrappedFinanceFields: contracts.reduce((n, c) => n + c.fields.length, 0) },
  };
  // Build and validate everything before writing. Native/mod sources are never written.
  for (const relative of Object.values(FILES)) parse(outputs[relative], relative);
  // Regeneration removes only unchanged files owned by the previous manifest.
  // It never recursively deletes directories or overwrites unknown helper files.
  const oldManifestPath = path.join(output, 'manifest.json');
  const oldManifest = fs.existsSync(oldManifestPath) ? JSON.parse(fs.readFileSync(oldManifestPath, 'utf8')) : null;
  const owned = new Map((oldManifest?.outputs || []).map(file => [file.path, file.hash]));
  for (const relative of walk(path.join(output, ROOT))) {
    const key = `${ROOT}/${relative}`;
    assert(owned.has(key), `Output contains an untracked file; use a fresh adapter output directory: ${key}`);
    assert.equal(sha(fs.readFileSync(path.join(output, key))), owned.get(key), `Generated output was manually modified: ${key}`);
  }
  const stale = [...owned.keys()].filter(key => !Object.hasOwn(outputs, key));
  for (const key of stale) {
    assert(key.startsWith(ROOT + '/') && !key.split('/').includes('..') && !path.isAbsolute(key), 'Unsafe path in previous output manifest');
    const destination = path.resolve(output, key);
    assert(destination.startsWith(output + path.sep), 'Output path escapes the adapter directory');
    if (fs.existsSync(destination)) fs.unlinkSync(destination);
  }
  for (const [relative, content] of Object.entries(outputs)) {
    const destination = path.join(output, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content, 'utf8');
  }
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return manifest;
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      assert(['--game', '--user-dir', '--output'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--'), 'Usage: --game <game> [--user-dir <user>] --output <adapter>');
      assert(!options[args[i]], `Repeated option ${args[i]}`);
      options[args[i]] = args[i + 1];
    }
    assert(options['--game'] && options['--output'], '--game and --output are required');
    const result = generate({ game: options['--game'], userDir: options['--user-dir'], output: options['--output'] });
    console.log(JSON.stringify({ ok: true, ...result.counts, outputs: result.outputs.map(o => o.path), requiredReplacePath: result.policy.requiredReplacePath }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { parse, generate, PUBLIC, LEVEL, FLAG, PREDICATE, FILES };
