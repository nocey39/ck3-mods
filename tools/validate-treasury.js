#!/usr/bin/env node
'use strict';

// Run with Node 18+: node tools/validate-treasury.js --game "<CK3>/game"
// --mod permits checking an untouched release with the same validator.
// This checks source contracts, not engine settlement or save compatibility.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const args = process.argv.slice(2);
function option(name, fallback) {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`${name} requires a path`);
  return path.resolve(args[at + 1]);
}
const mod = option('--mod', path.resolve(__dirname, '../treasury_equalization'));
const game = option('--game', process.env.CK3_GAME);
let failures = 0;
let checks = 0;
function check(label, action) {
  checks++;
  try { action(); console.log(`PASS ${label}`); }
  catch (error) { failures++; console.error(`FAIL ${label}: ${error.message}`); }
}
function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(filename) : [filename];
  });
}

// A small lexer retains source positions and ignores comments only outside strings.
// CK3 files allow repeated keys and bare list members, so JSON/YAML parsers are wrong here.
function parse(source, filename) {
  const tokens = [];
  const opens = [];
  let i = source.charCodeAt(0) === 0xFEFF ? 1 : 0;
  let line = 1;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) { if (c === '\n') line++; i++; continue; }
    if (c === '#') { while (i < source.length && source[i] !== '\n') i++; continue; }
    const start = i;
    const startLine = line;
    if (c === '"') {
      i++;
      let closed = false;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '"') { i++; closed = true; break; }
        if (source[i] === '\n') line++;
        i++;
      }
      assert(closed, `${filename}:${startLine}: unterminated string`);
      tokens.push({ type: 'string', value: source.slice(start + 1, i - 1), line: startLine });
    } else if ('{}=<>!?'.includes(c)) {
      let value = c;
      i++;
      if (c !== '{' && c !== '}' && source[i] === '=') { value += '='; i++; }
      const token = { type: 'symbol', value, line: startLine };
      if (value === '{') opens.push(tokens.length);
      if (value === '}') {
        assert(opens.length, `${filename}:${line}: unexpected closing brace`);
        const open = opens.pop();
        tokens[open].close = tokens.length;
        token.open = open;
      }
      tokens.push(token);
    } else {
      while (i < source.length && !/[\s{}=<>!?"#]/.test(source[i])) i++;
      tokens.push({ type: 'word', value: source.slice(start, i), line: startLine });
    }
  }
  assert(!opens.length, `${filename}:${tokens[opens[0]]?.line}: unclosed brace`);
  function blocks(start, end) {
    const result = [];
    for (let n = start; n < end; n++) {
      if (tokens[n].value !== '{') continue;
      const open = tokens[n];
      const key = tokens[n - 1]?.value === '=' ? tokens[n - 2]?.value : undefined;
      result.push({ key, start: n + 1, end: open.close, line: open.line,
        children: blocks(n + 1, open.close) });
      n = open.close;
    }
    return result;
  }
  return { filename, source, tokens, blocks: blocks(0, tokens.length) };
}
const allFiles = filesUnder(mod);
const parsed = [];
check('balanced script and GUI braces / quoted strings', () => {
  for (const filename of allFiles.filter(f => /\.(txt|gui|mod)$/.test(f))) {
    parsed.push(parse(fs.readFileSync(filename, 'utf8'), filename));
  }
});
const kinds = new Map();
for (const item of parsed) {
  const relative = path.relative(mod, item.filename).replaceAll('\\', '/');
  const kind = relative.split('/')[1];
  if (!kinds.has(kind)) kinds.set(kind, new Set());
  for (const block of item.blocks) {
    if (block.key) kinds.get(kind).add(block.key);
    if (kind === 'game_rules') for (const child of block.children) {
      if (child.key?.startsWith('teq_')) kinds.get(kind).add(child.key);
    }
  }
  // Scalar script values, such as teq_salary_cost_cap = 0.10, are also definitions.
  if (kind === 'script_values') {
    let depth = 0;
    for (let i = 0; i < item.tokens.length; i++) {
      const token = item.tokens[i];
      if (depth === 0 && token.type === 'word' && item.tokens[i + 1]?.value === '=') kinds.get(kind).add(token.value);
      if (token.value === '{') depth++;
      if (token.value === '}') depth--;
    }
  }
}

const locale = new Map();
check('localization UTF-8 BOM, duplicate keys, and language parity', () => {
  for (const lang of ['english', 'simp_chinese']) {
    const dictionary = new Map();
    for (const filename of allFiles.filter(f => f.includes(`${path.sep}${lang}${path.sep}`) && f.endsWith('.yml'))) {
      const bytes = fs.readFileSync(filename);
      assert(bytes.subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])), `${filename}: UTF-8 BOM missing`);
      const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
      assert(text.startsWith(`l_${lang}:`), `${filename}: wrong language header`);
      for (const [i, line] of text.split(/\r?\n/).entries()) {
        const match = /^\s+(\w+):(?:\d+)?\s*"/.exec(line);
        if (!match) continue;
        assert(!dictionary.has(match[1]), `${filename}:${i + 1}: duplicate ${match[1]}`);
        dictionary.set(match[1], filename);
      }
    }
    assert(dictionary.size, `${lang}: no localization loaded`);
    locale.set(lang, dictionary);
  }
  assert.deepEqual([...locale.get('english').keys()].sort(), [...locale.get('simp_chinese').keys()].sort());
});

function requireDefinition(kind, key, where) {
  assert(kinds.get(kind)?.has(key), `${where}: undefined ${kind} ${key}`);
}
check('active TEQ calls, GUI bindings, laws, modifiers, and script values resolve', () => {
  const anyCallable = ['scripted_effects', 'scripted_triggers', 'script_values'];
  const rhsKinds = {
    add_character_modifier: 'modifiers', remove_character_modifier: 'modifiers', has_character_modifier: 'modifiers',
    add_realm_law: 'laws', add_realm_law_skip_effects: 'laws', has_realm_law: 'laws', remove_realm_law: 'laws',
    law_group_type: 'law_groups', has_realm_law_in_group: 'law_groups', has_game_rule: 'game_rules',
    value: 'script_values', add: 'script_values', subtract: 'script_values', multiply: 'script_values',
    divide: 'script_values', min: 'script_values', max: 'script_values', scale: 'script_values'
  };
  for (const item of parsed) {
    const tokens = item.tokens;
    const isGameRules = item.filename.includes(`${path.sep}game_rules${path.sep}`);
    let depth = 0;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const where = `${item.filename}:${token.line}`;
      const call = /(?:^|\.)(teq_\w+)$/.exec(token.value);
      if (depth > 0 && !(isGameRules && depth === 1) && token.type === 'word' && call && ['=', '?=', '>', '<', '>=', '<=', '!='].includes(tokens[i + 1]?.value)) {
        assert(anyCallable.some(kind => kinds.get(kind)?.has(call[1])), `${where}: undefined TEQ callable ${call[1]}`);
      }
      if (token.type === 'word' && token.value.startsWith('teq_') && tokens[i - 1]?.value === '=') {
        const key = tokens[i - 2]?.value;
        if (rhsKinds[key]) requireDefinition(rhsKinds[key], token.value, where);
        if (['desc', 'text', 'custom_tooltip'].includes(key)) {
          assert(locale.get('english')?.has(token.value), `${where}: missing localization ${token.value}`);
        }
      }
      if (token.value === '{') depth++;
      if (token.value === '}') depth--;
      if (token.type === 'string') {
        for (const match of token.value.matchAll(/GetScriptedGui\('([^']+)'\)/g)) {
          if (match[1].startsWith('teq_')) requireDefinition('scripted_guis', match[1], where);
        }
        for (const match of token.value.matchAll(/ScriptValue\('([^']+)'\)/g)) {
          if (match[1].startsWith('teq_')) requireDefinition('script_values', match[1], where);
        }
        if (/^teq_\w+$/.test(token.value) && tokens[i - 1]?.value === '=' && ['text', 'raw_text', 'tooltip'].includes(tokens[i - 2]?.value)) {
          assert(locale.get('english')?.has(token.value), `${where}: missing localization ${token.value}`);
        }
      }
    }
    function checkLists(blocks) {
      for (const block of blocks) {
        if (block.key === 'on_actions') for (const token of tokens.slice(block.start, block.end)) {
          if (token.type === 'word' && token.value.startsWith('teq_')) requireDefinition('on_action', token.value, `${item.filename}:${token.line}`);
        }
        checkLists(block.children);
      }
    }
    checkLists(item.blocks);
  }
  for (const filename of allFiles.filter(f => f.endsWith('.yml'))) {
    const source = fs.readFileSync(filename, 'utf8');
    for (const match of source.matchAll(/ScriptValue\('([^']+)'\)/g)) {
      if (match[1].startsWith('teq_')) requireDefinition('script_values', match[1], filename);
    }
  }
});

function definition(key) {
  for (const item of parsed) {
    const block = item.blocks.find(entry => entry.key === key);
    if (block) return { item, block, values: item.tokens.slice(block.start, block.end).map(token => token.value) };
  }
  throw new Error(`Missing definition ${key}`);
}
function hasSequence(values, sequence) {
  return values.some((_, i) => sequence.every((token, offset) => values[i + offset] === token));
}
function requires(values, sequence, message) {
  assert(hasSequence(values, sequence), message);
}

check('migration schema agrees with owner setup and refresh gates', () => {
  const migration = definition('teq_migrate_legacy').values;
  const at = migration.findIndex((token, i) => token === 'teq_policy_version' && migration[i - 1] === '=');
  assert(at >= 0 && migration[at + 1] === 'value' && migration[at + 2] === '=', 'Migration must assign a policy schema');
  const version = migration[at + 3];
  assert(Number.isInteger(Number(version)) && Number(version) > 0, 'Invalid policy schema');
  for (const key of ['teq_apply_budget', 'teq_auto_tick']) {
    requires(definition(key).values, ['var:teq_policy_version', '<', version], `${key} uses a stale migration threshold`);
  }
  for (const key of ['teq_initialize_budget_owner', 'teq_budget_owner_needs_setup']) {
    requires(definition(key).values, ['var:teq_policy_version', '>=', version], `${key} uses a stale setup threshold`);
  }
});

check('region registration is tracked, deduplicated, applied, and synchronized', () => {
  const registration = definition('teq_register_region');
  const values = registration.values;
  requires(values, ['top_liege.primary_title', '=', '{', 'save_scope_as', '=', 'teq_join_owner'], 'Registration must capture the fiscal title');
  requires(values, ['name', '=', 'teq_region_owner', 'value', '=', 'scope:teq_join_owner'], 'Region must record the same fiscal owner');
  requires(values, ['NOT', '=', '{', 'is_target_in_variable_list', '=', '{', 'name', '=', 'teq_regions', 'target', '=', 'scope:teq_join_title'], 'Repeated registration must not duplicate title-list entries');
  requires(values, ['add_to_variable_list', '=', '{', 'name', '=', 'teq_regions', 'target', '=', 'scope:teq_join_title'], 'New regions must join the teardown/maintenance list');
  const addAt = values.indexOf('add_to_variable_list');
  const applyAt = values.indexOf('teq_apply_flow');
  const syncAt = values.lastIndexOf('teq_flow_sync_needed');
  assert(addAt >= 0 && applyAt > addAt && syncAt > applyAt, 'Registration must track, apply, then request central synchronization');
  const reconcile = definition('teq_reconcile_character').values;
  assert(reconcile.indexOf('teq_register_region') >= 0 && reconcile.indexOf('teq_refresh_need_sum') > reconcile.indexOf('teq_register_region'), 'Reconciliation must sync after registration');
  requires(definition('teq_restore_regions').values, ['var:teq_region_owner', '=', 'scope:teq_fiscal_title'], 'Teardown must protect regions transferred to another fiscal owner');
  requires(definition('teq_refresh_need_sum').values, ['var:teq_region_owner', '=', 'scope:teq_need_owner'], 'Need totals must exclude old list entries now owned by another central title');
});

check('monthly maintenance includes AI and keeps reentry locks around budget work', () => {
  const tick = definition('teq_auto_tick');
  assert(!tick.values.includes('is_ai'), 'Monthly upkeep must not skip stable non-quarter AI budgets');
  assert(tick.values.includes('teq_monthly_safety'), 'Non-quarter months must still maintain budgets');
  const safety = definition('teq_monthly_safety').values;
  requires(safety, ['var:teq_region_owner', '=', 'scope:teq_fiscal_title'], 'Monthly maintenance must not touch a transferred region through its old cached list');
  const lockAt = safety.findIndex((token, i) => token === 'teq_review_lock' && safety[i - 2] === 'set_variable');
  const unlockAt = safety.findIndex((token, i) => token === 'teq_review_lock' && safety[i - 2] === 'remove_variable');
  assert(lockAt >= 0 && safety.indexOf('teq_apply_budget') > lockAt && unlockAt > safety.indexOf('teq_apply_budget'), 'Maintenance must hold its review lock through final budget application');
  const budget = definition('teq_apply_budget').values;
  requires(budget, ['NOT', '=', '{', 'has_variable', '=', 'teq_budget_lock'], 'Budget recursion must be guarded');
  requires(budget, ['remove_variable', '=', 'teq_budget_lock'], 'Budget application must release its lock');
});

check('fresh native capacity and receiver units precede rate changes', () => {
  const measure = definition('teq_measure_budget').values;
  assert(measure.includes('holder.character_treasury_new_budget_capacity'), 'Spendable treasury must use the live native capacity getter');
  assert(!measure.includes('var:teq_applied_budget'), 'Spendable treasury must not depend on saved payment diagnostics');
  const budget = definition('teq_apply_budget').values;
  const nativeEnact = budget.lastIndexOf('enact_treasury_budgets_no_costs_no_opinion_effects');
  const setRate = budget.indexOf('set_treasury_budget_base_rate_ministries');
  assert(nativeEnact >= 0 && setRate > nativeEnact, 'Rate adjustment must follow native enactment');
  for (const channel of ['development', 'military', 'cardinal']) {
    const name = `teq_native_${channel}_units`;
    const first = budget.indexOf(name);
    const lastBeforeRate = budget.slice(0, setRate).lastIndexOf(name);
    assert(first > nativeEnact && lastBeforeRate > first, `${channel} units must reset and resample after native enactment, before rate changes`);
  }
  const developmentRate = definition('teq_development_base_rate').values;
  requires(developmentRate, ['divide', '=', 'var:teq_native_development_units'], 'Development rate must use measured native receivers');
  assert(!developmentRate.includes('tgp_has_access_to_ministry_trigger') && !developmentRate.includes('var:teq_need_sum'), 'Development rate must not guess receiver units from government or TEQ need');
});

check('a central title cannot be registered as its own region', () => {
  requires(definition('teq_public_tax_subject').values, ['NOT', '=', '{', 'this', '=', 'top_liege'], 'Immediate registration must exclude the fiscal ruler');
  requires(definition('teq_recipient_valid').values, ['NOT', '=', '{', 'this', '=', 'scope:teq_fiscal_title.holder'], 'Quarterly review must exclude the fiscal ruler');
  requires(definition('teq_region_title_valid').values, ['NOT', '=', '{', 'this', '=', 'var:teq_region_owner'], 'Cached self-registration must be rejected');
});

if (game) {
  check('annual guard covers the actual native budget fallback pulse', () => {
    const filename = path.join(game, 'common/on_action/yearly_on_actions.txt');
    const native = parse(fs.readFileSync(filename, 'utf8'), filename);
    const expected = native.blocks.filter(block => native.tokens.slice(block.start, block.end).some(token => /^enact_treasury_budgets(?:_|$)/.test(token.value))).map(block => block.key);
    assert(expected.length, 'No native annual budget enactment found; verify the game version and path');
    const hooks = parsed.filter(item => item.filename.includes(`${path.sep}on_action${path.sep}`));
    for (const key of expected) {
      const covered = hooks.some(item => item.blocks.some(block => block.key === key && block.children.some(child => child.key === 'on_actions' && item.tokens.slice(child.start, child.end).some(token => token.value === 'teq_yearly_salary_guard'))));
      assert(covered, `Native ${key} enacts budgets but has no TEQ annual salary guard`);
      console.log(`  Native fallback: ${key}`);
    }
  });
} else {
  console.log('SKIP native annual hook check: pass --game "<CK3>/game" (or set CK3_GAME)');
}
console.log(`${checks - failures}/${checks} checks passed. Engine settlement and save compatibility require in-game verification.`);
process.exitCode = failures ? 1 : 0;
