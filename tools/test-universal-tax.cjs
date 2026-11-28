#!/usr/bin/env node
'use strict';

// Isolated synthetic databases exercise the actual generator with names that
// do not occur in CK3. No real mod, game installation or save is written.
// The contract gate is an explicit input here. Live TEQ-chain/exit behavior
// needs separate tests against the real predicate and reconciliation sources.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const stage = path.resolve(__dirname, '..');
const arguments_ = process.argv.slice(2);
const generatorAt = arguments_.indexOf('--generator');
const generatorArg = generatorAt >= 0 ? arguments_[generatorAt + 1] : arguments_[0];
if (generatorAt >= 0) assert(generatorArg, '--generator requires a path');
const generator = generatorArg ? path.resolve(generatorArg) : path.join(stage, 'tools/generate-universal-tax.js');
const fixtureRoot = path.join(stage, 'work/universal-tax-test-fixtures');
fs.mkdirSync(fixtureRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(fixtureRoot, 'fixture-'));
const game = path.join(scratch, 'game'), user = path.join(scratch, 'user');
function write(root, relative, text) { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }

// Independent parser: preserve ordered/repeated assignments and bare members.
function parse(text, file = '<fixture>') {
  const t = (text.replace(/^\uFEFF/, '').match(/"(?:\\.|[^"\\])*"|#[^\r\n]*|\?=|>=|<=|!=|[{}=<>]|[^\s{}=<>!?"#]+/g) || []).filter(x => !x.startsWith('#'));
  let i = 0;
  function list(nested) {
    const result = [];
    while (i < t.length && t[i] !== '}') {
      const key = t[i++];
      if (!['=', '?=', '>=', '<=', '!=', '>', '<'].includes(t[i])) { result.push({ key: null, value: key }); continue; }
      const op = t[i++];
      let value;
      if (t[i] === '{') { i++; value = list(true); }
      else { assert(t[i] !== undefined, `${file}: missing value`); value = t[i++]; }
      result.push({ key, op, value });
    }
    if (nested) assert.equal(t[i++], '}', `${file}: unmatched opening brace`);
    return result;
  }
  const result = list(false);
  assert.equal(i, t.length, `${file}: unmatched closing brace`);
  return result;
}
function definitions(text) { return new Map(parse(text).map(node => [node.key, node])); }
function files(root) { return fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(root, e.name)) : [path.join(root, e.name)]) : []; }
function loaded(root, relative) {
  const result = new Map();
  for (const file of files(path.join(root, relative)).filter(f => f.endsWith('.txt')).sort()) {
    for (const n of parse(fs.readFileSync(file, 'utf8'), file)) if (n.key) { assert(!result.has(n.key), `Duplicate generated key ${n.key}`); result.set(n.key, n); }
  }
  return result;
}
const child = (nodes, key) => nodes.find(n => n.key === key);
const mathKeys = new Set(['tax', 'min_tax', 'tax_factor']);
function contractLevels(node) { return child(node.value, 'obligation_levels')?.value || []; }
function groupContracts(node) { return (child(node.value, 'contracts')?.value || []).map(n => n.value); }
function isTributary(node) { return child(node.value, 'is_tributary')?.value === 'yes'; }

const core = `
alien_revenue_a = { obligation_levels = {
 low = { tax = 0.12 min_tax = 0.01 tax_factor = -1
  subject_modifier = { monthly_income = 7 monthly_treasury_from_salary_budget_base = 2 }
  flag = star_tax }
 high = { tax = { value = 0.42 if = { limit = { scope:liege = { is_at_war = yes } } add = 0.08 } } min_tax = 0.02 }
} }
alien_revenue_b = { obligation_levels = { default = { tax = 0.27 tax_factor = 0.4 levies = 0.3 } } }
alien_dynamic_role = { obligation_levels = { default = {
 tax_factor = { value = 0 if = { limit = { scope:liege = { is_at_war = yes } } add = scope:liege.custom_factor } else = { add = -1 } }
 subject_modifier = { monthly_control_change = 0.3 } } } }
alien_shared_tribute = { obligation_levels = { default = { tax = 0.31 min_tax = 0.03 tax_factor = -0.2 piety = 0.1 } } }
alien_personal_salary = { obligation_levels = { default = {
 subject_modifier = { monthly_treasury_from_salary_budget_base = 3 monthly_income = 11 domicile_monthly_gold_add = 5 }
 contribution_desc = { desc = "salary with # literal comment character" } } } }
alien_zero_tax = { obligation_levels = { default = { tax = { value = 0 } min_tax = 0 tax_factor = 0 } } }
alien_duplicate_key = { obligation_levels = { default = { tax = 0.19 } } }
`;
const groupsText = `
alien_multi_group = { contracts = { alien_revenue_a alien_revenue_b alien_dynamic_role alien_shared_tribute alien_personal_salary alien_alias_contract } modify_contract_layout = "alien layout" }
alien_zero_group = { contracts = { alien_zero_tax } }
alien_no_tax_group = { contracts = { alien_personal_salary } }
alien_empty_group = { contracts = { } }
alien_outer_tribute = { is_tributary = yes contracts = { alien_shared_tribute } tributary_heir_succession = no }
`;
const governments = `
star_administration_9284 = { rules = { treasury = yes } vassal_contract_group = alien_multi_group }
star_trade_9284 = { rules = { treasury = yes } vassal_contract_group = alien_zero_group }
star_new_9284 = { rules = { treasury = yes } vassal_contract_group = alien_no_tax_group }
ordinary_unlisted_9284 = { rules = { treasury = no } vassal_contract_group = alien_multi_group }
`;
write(game, 'common/governments/alien.txt', governments);
write(game, 'common/subject_contracts/contracts/core.txt', core);
write(game, 'common/subject_contracts/groups/core.txt', groupsText);
write(game, 'common/subject_contracts/contracts/replaced/old.txt', 'must_disappear_contract = { obligation_levels = { default = { tax = 0.99 } } }');
write(game, 'common/subject_contracts/groups/replaced/old.txt', 'must_disappear_group = { contracts = { must_disappear_contract } }');

const modA = path.join(user, 'external-a'), modB = path.join(user, 'external-b'), self = path.join(user, 'teq-old');
const aOverride = 'alien_contested = { obligation_levels = { default = { tax = 0.22 tax_factor = -0.3 } } }';
const bOverride = 'alien_contested = { obligation_levels = { default = { tax = 0.37 tax_factor = -0.6 } } }';
const overrideGroup = 'alien_override_group = { contracts = { alien_contested alien_personal_salary alien_duplicate_key } }';
write(modA, 'common/subject_contracts/contracts/contested.txt', aOverride);
write(modB, 'common/subject_contracts/contracts/contested.txt', bOverride);
write(modB, 'common/subject_contracts/groups/contested.txt', overrideGroup);
const duplicateWinner = 'alien_duplicate_key = { obligation_levels = { default = { tax = 0.64 min_tax = 0.04 } } }';
write(modA, 'common/subject_contracts/contracts/zz_duplicate.txt', duplicateWinner);
const externalSelfCollision = `alien_revenue_a = { obligation_levels = {
 low = { tax = 0.28 min_tax = 0.02 tax_factor = -1 subject_modifier = { monthly_income = 7 monthly_treasury_from_salary_budget_base = 2 } flag = star_tax }
 high = { tax = { value = 0.45 if = { limit = { scope:liege = { is_at_war = yes } } add = 0.08 } } min_tax = 0.02 }
} }`;
write(modA, 'common/subject_contracts/contracts/zz_external_self_key.txt', externalSelfCollision);
const aliasSource = `@tax_anchor = 0.18
@tax_alias = @tax_anchor
@factor_anchor = -0.4
@factor_alias = @factor_anchor
@salary_anchor = 9
@salary_alias = @salary_anchor
alien_alias_contract = { obligation_levels = { default = { tax = @tax_alias min_tax = @tax_anchor tax_factor = @factor_alias subject_modifier = { monthly_income = @salary_alias } } } }`;
const aliasResolved = 'alien_alias_contract = { obligation_levels = { default = { tax = 0.18 min_tax = 0.18 tax_factor = -0.4 subject_modifier = { monthly_income = 9 } } } }';
write(modA, 'common/subject_contracts/contracts/aliases.txt', aliasSource);
write(modB, 'common/subject_contracts/contracts/replaced/revived.txt', 'later_revived_contract = { obligation_levels = { default = { tax = 0.04 tax_factor = -0.75 } } }');
write(modB, 'common/subject_contracts/groups/replaced/revived.txt', 'later_revived_group = { contracts = { later_revived_contract } }');
write(modB, 'common/subject_contracts/groups/replaced/later-note.info', 'Opaque helper: preserve bytes; # { this is deliberately not script syntax\n');
write(self, 'common/subject_contracts/contracts/zz_teq_vassal_tax_contracts.txt', 'alien_revenue_a = { obligation_levels = { legacy_broken = { tax = 999 } } }');
write(self, 'common/subject_contracts/contracts/zz_teq_public_tax_factors.txt', 'alien_dynamic_role = { obligation_levels = { legacy_broken = { tax_factor = 999 } } }');
write(user, 'mod/a.mod', `name="External A"\npath="external-a"\nreplace_path="common/subject_contracts/contracts/replaced"\nreplace_path="common/subject_contracts/groups/replaced"\n`);
write(user, 'mod/b.mod', 'name="External B"\npath="external-b"\n');
write(user, 'mod/teq.mod', 'name="Treasury Equalization"\nremote_file_id="3839551460"\npath="teq-old"\n');

let passed = 0, failed = 0;
function test(label, fn) { try { fn(); passed++; console.log(`PASS ${label}`); } catch (e) { failed++; console.error(`FAIL ${label}: ${e.stack || e.message}`); } }
function generate(order, output) {
  write(user, 'dlc_load.json', JSON.stringify({ enabled_mods: order, disabled_dlcs: [] }));
  const run = cp.spawnSync(process.execPath, [generator, '--game', game, '--user-dir', user, '--output', output], { encoding: 'utf8' });
  assert.equal(run.status, 0, `Generator failed:\n${run.stdout}\n${run.stderr}`);
  return { contracts: loaded(output, 'common/subject_contracts/contracts'), groups: loaded(output, 'common/subject_contracts/groups') };
}
let generated;
test('generator accepts only unknown custom governments/contracts and emits output', () => {
  generated = generate(['mod/a.mod', 'mod/b.mod', 'mod/teq.mod'], path.join(scratch, 'generated'));
  assert(generated.contracts.size > 0 && generated.groups.size > 0);
});

const expectedContracts = definitions(core);
for (const [key, node] of definitions(externalSelfCollision)) expectedContracts.set(key, node);
for (const [key, node] of definitions(aliasResolved)) expectedContracts.set(key, node);
for (const [key, node] of definitions(duplicateWinner)) expectedContracts.set(key, node);
for (const [key, node] of definitions(bOverride)) expectedContracts.set(key, node);
for (const [key, node] of definitions('later_revived_contract = { obligation_levels = { default = { tax = 0.04 tax_factor = -0.75 } } }')) expectedContracts.set(key, node);
const expectedGroups = definitions(groupsText + overrideGroup + '\nlater_revived_group = { contracts = { later_revived_contract } }');
let universalKey;
test('every non-tributary group gets exactly one shared tax obligation; tributary group is unchanged', () => {
  const extraKeys = new Set();
  for (const [key, original] of expectedGroups) {
    const current = generated.groups.get(key) || original;
    const oldContracts = groupContracts(original), newContracts = groupContracts(current);
    if (isTributary(original)) assert.deepEqual(current, original, 'Outer tributary group changed');
    else {
      assert.deepEqual(newContracts.slice(0, oldContracts.length), oldContracts, `${key}: native contract list/order changed`);
      const extra = newContracts.slice(oldContracts.length);
      assert.equal(extra.length, 1, `${key}: expected one universal obligation`);
      extraKeys.add(extra[0]);
      const unchanged = { ...current, value: current.value.map(n => n.key === 'contracts' ? child(original.value, 'contracts') : n) };
      assert.deepEqual(unchanged, original, `${key}: unrelated group metadata changed`);
    }
  }
  assert.equal(extraKeys.size, 1, 'Multiple universal tax definitions would duplicate collection');
  universalKey = [...extraKeys][0];
  assert(generated.contracts.has(universalKey), 'Universal contract is undefined');
});

function originalMath(value) { return Array.isArray(value) ? value : [{ key: 'value', op: '=', value }]; }
function nativeFallback(node) {
  assert(Array.isArray(node.value), `${node.key}: conditional math expected`);
  assert.deepEqual(node.value.map(n => n.key), ['if', 'else'], `${node.key}: unexpected unguarded operations`);
  const branch = node.value[0].value;
  assert.deepEqual(child(branch, 'limit')?.value, [{ key: 'teq_public_contract_active', op: '=', value: 'yes' }]);
  assert.deepEqual(branch.filter(n => n.key !== 'limit'), [{ key: 'value', op: '=', value: '0' }], `${node.key}: native tax component not neutralized to zero`);
  return node.value[1].value;
}
function normalize(nodes, originals) {
  assert.equal(nodes.length, originals.length, 'Original contract gained or lost fields');
  return nodes.map((n, i) => {
    const original = originals[i];
    assert.equal(n.key, original.key, 'Original contract field order/key changed');
    assert.equal(n.op, original.op, 'Original contract operator changed');
    if (mathKeys.has(n.key)) {
      const fallback = nativeFallback(n);
      assert.deepEqual(fallback, originalMath(original.value), `${n.key}: original mathematics changed`);
      return original;
    }
    return Array.isArray(n.value) ? { ...n, value: normalize(n.value, original.value) } : n;
  });
}
test('all original tax components are guarded; all non-tax/salary/estate AST stays native', () => {
  for (const [key, original] of expectedContracts) {
    const current = generated.contracts.get(key) || original;
    const hasTax = contractLevels(original).some(level => level.value.some(n => mathKeys.has(n.key)));
    if (hasTax) assert(generated.contracts.has(key), `Unknown contract ${key} was skipped`);
    assert.deepEqual(normalize(current.value, original.value), original.value, `${key}: original fallback or non-tax behavior changed`);
  }
  const permitted = new Set([...expectedContracts.keys(), universalKey]);
  for (const key of generated.contracts.keys()) assert(permitted.has(key), `Unexpected contract ${key}`);
  assert(!generated.contracts.has('must_disappear_contract'));
  assert(!generated.groups.has('must_disappear_group'));
});

function resolve(ref, env, scope = env.subject) {
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(ref)) return Number(ref);
  if (ref === 'yes' || ref === 'no') return ref === 'yes';
  const dot = ref.indexOf('.');
  if (dot >= 0) return resolve(ref.slice(dot + 1), env, resolve(ref.slice(0, dot), env, scope));
  if (ref.startsWith('scope:')) { assert(ref.slice(6) in env, `Unknown named scope ${ref}`); return env[ref.slice(6)]; }
  assert(scope && Object.hasOwn(scope, ref), `Unknown fixture/native getter ${ref}`);
  return scope[ref];
}
function condition(nodes, env, scope = env.subject) {
  return nodes.every(n => {
    if (n.key === 'teq_public_contract_active') return env.active === (n.value === 'yes');
    if (n.key === 'NOT') return !condition(n.value, env, scope);
    if (n.key === 'AND') return condition(n.value, env, scope);
    if (n.key === 'OR') return n.value.some(x => condition([x], env, scope));
    if (Array.isArray(n.value)) return condition(n.value, env, resolve(n.key, env, scope));
    const a = resolve(n.key, env, scope), b = resolve(n.value, env, scope);
    if (n.op === '=') return a === b;
    if (n.op === '!=') return a !== b;
    throw new Error(`Unsupported fixture operator ${n.op}`);
  });
}
function evaluate(nodes, env, initial = 0) {
  if (!Array.isArray(nodes)) return resolve(nodes, env);
  let result = initial, taken = false;
  for (const n of nodes) {
    if (n.key === 'if' || n.key === 'else_if') {
      if (n.key === 'if') taken = false;
      if (!taken && condition(child(n.value, 'limit')?.value || [], env)) { taken = true; result = evaluate(n.value.filter(x => x.key !== 'limit'), env, result); }
    } else if (n.key === 'else') { if (!taken) result = evaluate(n.value, env, result); taken = true; }
    else {
      const value = evaluate(n.value, env);
      if (n.key === 'value') result = value;
      else if (n.key === 'add') result += value;
      else if (n.key === 'subtract') result -= value;
      else if (n.key === 'multiply') result *= value;
      else if (n.key === 'divide') { assert.notEqual(value, 0); result /= value; }
      else if (n.key === 'min') result = Math.max(result, value);
      else if (n.key === 'max') result = Math.min(result, value);
      else throw new Error(`Unsupported generated/native math ${n.key}`);
    }
  }
  assert(Number.isFinite(result));
  return result;
}
function choices(lists) { return lists.reduce((acc, list) => acc.flatMap(prefix => list.map(v => [...prefix, v])), [[]]); }
function environments(active) { return [false, true].flatMap(is_at_war => [-1, -0.2, 0, 0.5, 10].map(custom_factor => ({ active, subject: {}, liege: { is_at_war, custom_factor } }))); }
test('unknown multiple/zero/no-tax groups collect once at 100%, even with a zero multiplier', () => {
  for (const [key, original] of expectedGroups) {
    if (isTributary(original)) continue;
    const current = generated.groups.get(key) || original;
    const options = groupContracts(current).map(name => contractLevels(generated.contracts.get(name) || expectedContracts.get(name)));
    for (const selected of choices(options)) for (const env of environments(true)) {
      let tax = 0, floor = 0, factor = 0;
      for (const level of selected) for (const n of level.value) {
        if (n.key === 'tax') tax += evaluate(n.value, env);
        if (n.key === 'min_tax') floor += evaluate(n.value, env);
        if (n.key === 'tax_factor') factor += evaluate(n.value, env);
      }
      assert.equal(tax, 1, `${key}: collected more/less than one base tax`);
      assert.equal(floor, 1, `${key}: duplicate/missing minimum`);
      assert.equal(factor, 0, `${key}: original role factor survived`);
      assert.equal(Math.max(tax, floor) * (1 + factor), 1, `${key}: final contract-stage ratio`);
    }
  }
});

test('inactive and shared outer-tributary math remains original across dynamic states', () => {
  for (const [key, original] of expectedContracts) {
    const current = generated.contracts.get(key) || original;
    for (const level of contractLevels(original)) {
      const changed = contractLevels(current).find(n => n.key === level.key);
      assert(changed, `${key}.${level.key}: lost level`);
      for (const n of level.value.filter(n => mathKeys.has(n.key))) {
        const replacement = child(changed.value, n.key);
        for (const env of environments(false)) assert.equal(evaluate(replacement.value, env), evaluate(n.value, env), `${key}.${level.key}.${n.key}: inactive/native mismatch`);
      }
    }
  }
  const unified = contractLevels(generated.contracts.get(universalKey));
  for (const level of unified) for (const n of level.value.filter(n => mathKeys.has(n.key))) for (const env of environments(false)) {
    assert.equal(evaluate(n.value, env), 0, 'Inactive universal obligation must impose no tax');
  }
});

test('load-order reversal and replace_path affect the resolved source database', () => {
  const reversed = generate(['mod/b.mod', 'mod/a.mod', 'mod/teq.mod'], path.join(scratch, 'generated-reversed'));
  const nativeA = definitions(aOverride).get('alien_contested').value;
  assert.deepEqual(normalize(reversed.contracts.get('alien_contested').value, nativeA), nativeA, 'Later same-path mod must win');
  assert(!reversed.contracts.has('later_revived_contract'), 'Later replace_path must remove an earlier mod contribution');
  assert(!reversed.groups.has('later_revived_group'), 'Later group replacement must remove earlier group contribution');
});

test('full replacement preserves opaque helpers, removes owned stale output, and refuses unknown files', () => {
  const output = path.join(scratch, 'regeneration');
  generate(['mod/a.mod', 'mod/b.mod', 'mod/teq.mod'], output);
  const helper = path.join(output, 'common/subject_contracts/groups/replaced/later-note.info');
  assert.deepEqual(fs.readFileSync(helper), fs.readFileSync(path.join(modB, 'common/subject_contracts/groups/replaced/later-note.info')));
  generate(['mod/b.mod', 'mod/a.mod', 'mod/teq.mod'], output);
  assert(!fs.existsSync(helper), 'A stale generated helper survived replace_path regeneration');
  const userNote = 'unowned note must survive\n';
  write(output, 'common/subject_contracts/groups/unowned.note', userNote);
  const manifestBefore = fs.readFileSync(path.join(output, 'manifest.json'));
  const refused = cp.spawnSync(process.execPath, [generator, '--game', game, '--user-dir', user, '--output', output], { encoding: 'utf8' });
  assert.notEqual(refused.status, 0, 'Unknown output contents must not be silently removed or hidden');
  assert.equal(fs.readFileSync(path.join(output, 'common/subject_contracts/groups/unowned.note'), 'utf8'), userNote);
  assert.deepEqual(fs.readFileSync(path.join(output, 'manifest.json')), manifestBefore, 'Refused generation must preserve its prior manifest');
});

test('strict evaluator rejects unknown fields rather than converting them to false', () => {
  assert.throws(() => condition([{ key: 'unknown_native_getter', op: '=', value: 'yes' }], environments(false)[0]), /Unknown fixture\/native getter/);
  assert.throws(() => evaluate([{ key: 'value', op: '=', value: 'unknown_native_number' }], environments(false)[0]), /Unknown fixture\/native getter/);
});

test('undefined or cyclic file-local aliases are rejected instead of silently changing tax or wages', () => {
  for (const [label, source] of [
    ['undefined', aliasSource.replace('@salary_alias = @salary_anchor', '@salary_alias = @missing_salary')],
    ['cycle', aliasSource.replace('@salary_alias = @salary_anchor', '@salary_alias = @salary_loop\n@salary_loop = @salary_alias')],
  ]) {
    write(modA, 'common/subject_contracts/contracts/aliases.txt', source);
    const output = path.join(scratch, `rejected-${label}`);
    const run = cp.spawnSync(process.execPath, [generator, '--game', game, '--user-dir', user, '--output', output], { encoding: 'utf8' });
    assert.notEqual(run.status, 0, `${label}: invalid alias must fail closed`);
    assert(!fs.existsSync(path.join(output, 'manifest.json')), `${label}: invalid database must not receive a generated manifest`);
  }
  write(modA, 'common/subject_contracts/contracts/aliases.txt', aliasSource);
});

test('an enabled old generated adapter is excluded before its full replace_path is applied', () => {
  const oldAdapter = path.join(user, 'old-adapter');
  write(oldAdapter, 'manifest.json', JSON.stringify({ generator: 'teq-universal-public-tax' }));
  write(oldAdapter, 'common/subject_contracts/contracts/poison.txt', 'old_adapter_poison = { obligation_levels = { default = { tax = 999 } } }');
  write(user, 'mod/old-adapter.mod', 'name="Old generated adapter"\npath="old-adapter"\nreplace_path="common/subject_contracts"\n');
  const current = generate(['mod/a.mod', 'mod/b.mod', 'mod/teq.mod', 'mod/old-adapter.mod'], path.join(scratch, 'old-adapter-excluded'));
  assert.deepEqual(current.contracts, generated.contracts, 'Old adapter must not erase or override effective contract input');
  assert.deepEqual(current.groups, generated.groups, 'Old adapter replace_path must not erase input groups');
});

console.log(`${passed}/${passed + failed} independent universal-tax fixture regressions passed`);
console.log(`Scratch fixtures: ${scratch}`);
console.log('Scope active/inactive is an explicit gate input; engine tax, live fiscal-chain eligibility and refund restoration require separate verification.');
if (failed) process.exitCode = 1;
