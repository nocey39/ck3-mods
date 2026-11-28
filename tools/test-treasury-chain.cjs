#!/usr/bin/env node
'use strict';

// Run actual stage predicates and flow/refund effects with explicit engine
// fixture inputs. Native modifier refresh and obligation setters are recorded
// adapters; no game, mod installation, save, or real currency is mutated.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const arguments_ = process.argv.slice(2), modAt = arguments_.indexOf('--mod');
const modArg = modAt >= 0 ? arguments_[modAt + 1] : arguments_[0];
if (modAt >= 0) assert(modArg, '--mod requires a path');
const defaultMod = path.join(__dirname, '../treasury_equalization');
const mod = path.resolve(modArg || (fs.existsSync(defaultMod) ? defaultMod : path.join(__dirname, '../stage/treasury_equalization')));
function parse(text) {
  const t = (text.replace(/^\uFEFF/, '').match(/"(?:\\.|[^"\\])*"|#[^\r\n]*|\?=|>=|<=|!=|[{}=<>]|[^\s{}=<>!?"#]+/g) || []).filter(x => !x.startsWith('#'));
  let i = 0;
  function block(nested) {
    const out = [];
    while (i < t.length && t[i] !== '}') {
      const key = t[i++];
      if (!['=', '?=', '>=', '<=', '!=', '>', '<'].includes(t[i])) { out.push({ key: null, value: key }); continue; }
      const op = t[i++];
      let value;
      if (t[i] === '{') { i++; value = block(true); } else { assert(t[i] !== undefined); value = t[i++]; }
      out.push({ key, op, value });
    }
    if (nested) assert.equal(t[i++], '}');
    return out;
  }
  const result = block(false); assert.equal(i, t.length); return result;
}
function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]); }
function definitions(relative) {
  const map = new Map();
  for (const file of walk(path.join(mod, relative)).filter(f => f.endsWith('.txt'))) for (const n of parse(fs.readFileSync(file, 'utf8'))) {
    if (!n.key) continue; assert(!map.has(n.key), `Duplicate ${n.key}`); map.set(n.key, n.value);
  }
  return map;
}
const triggers = definitions('common/scripted_triggers'), effects = definitions('common/scripted_effects'), values = definitions('common/script_values'), onActions = definitions('common/on_action');
const tiers = { tier_barony: 1, tier_county: 2, tier_duchy: 3, tier_kingdom: 4, tier_empire: 5, tier_hegemony: 6 };
const field = (entries, key) => entries.find(e => e.key === key);
function nextContext(scope, target, ctx) { return { ...ctx, previous: [scope, ...ctx.previous] }; }
function lookup(ref, scope, ctx) {
  ref = ref.replace(/^"|"$/g, '');
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(ref)) return Number(ref);
  if (ref === 'yes' || ref === 'no') return ref === 'yes';
  if (Object.hasOwn(tiers, ref)) return tiers[ref];
  const dot = ref.indexOf('.');
  if (dot >= 0) return lookup(ref.slice(dot + 1), lookup(ref.slice(0, dot), scope, ctx), ctx);
  if (ref.startsWith('scope:')) return ctx.scopes[ref.slice(6)];
  if (ref.startsWith('global_var:')) return ctx.globals?.[ref.slice(11)];
  if (ref.startsWith('var:')) return scope?.vars?.[ref.slice(4)];
  if (ref === 'this') return scope;
  if (ref === 'prev') return ctx.previous[0];
  if (ref === 'root') return ctx.root;
  if (ref === 'current_year') return 1000;
  if (ref === 'current_month') return 1;
  if (scope && Object.hasOwn(scope, ref)) return scope[ref];
  if (values.has(ref)) return number(values.get(ref), scope, ctx);
  throw new Error(`Unknown fixture/native reference ${ref}`);
}
function ancestors(scope) {
  const result = [], seen = new Set();
  for (let at = scope.liege; at; at = at.liege) { assert(!seen.has(at), 'Fixture liege cycle'); seen.add(at); result.push(at); }
  return result;
}
function descendants(scope) { return scope.vassals.flatMap(v => [v, ...descendants(v)]); }
function condition(entries, scope, ctx) {
  if (!scope) return false;
  let taken = false;
  for (const { key, op, value } of entries) {
    let result;
    if (key === 'trigger_if' || key === 'trigger_else_if') {
      if (key === 'trigger_if') taken = false;
      if (!taken && condition(field(value, 'limit')?.value || [], scope, ctx)) {
        taken = true; if (!condition(value.filter(n => n.key !== 'limit'), scope, ctx)) return false;
      }
      continue;
    }
    if (key === 'trigger_else') { if (!taken && !condition(value, scope, ctx)) return false; continue; }
    if (key === 'NOT') result = !condition(value, scope, ctx);
    else if (key === 'AND') result = condition(value, scope, ctx);
    else if (key === 'OR') result = value.some(n => condition([n], scope, ctx));
    else if (key === 'always') result = value === 'yes';
    else if (key === 'exists') result = lookup(value, scope, ctx) != null;
    else if (key === 'has_variable') result = Object.hasOwn(scope.vars || {}, value);
    else if (key === 'has_global_variable') result = Object.hasOwn(ctx.globals || {}, value);
    else if (key === 'has_variable_list') result = Object.hasOwn(scope.lists || {}, value);
    else if (key === 'has_character_modifier') result = scope.modifiers.has(value);
    else if (key === 'vassal_contract_has_flag' || key === 'subject_contract_has_flag') result = scope.contractFlags.has(value);
    else if (key === 'government_has_flag') result = scope.governmentFlags.has(value);
    else if (key === 'has_game_rule') result = ctx.gameRules.has(value);
    else if (key === 'is_target_in_variable_list') {
      const list = field(value, 'name').value, target = lookup(field(value, 'target').value, scope, ctx);
      result = (scope.lists[list] || []).includes(target);
    } else if (['any_liege_or_above', 'any_vassal', 'any_vassal_or_below'].includes(key)) {
      const list = key === 'any_liege_or_above' ? ancestors(scope) : key === 'any_vassal' ? scope.vassals : descendants(scope);
      result = list.some(target => condition(value, target, nextContext(scope, target, ctx)));
    } else if (triggers.has(key) && ['yes', 'no'].includes(value)) result = condition(triggers.get(key), scope, ctx) === (value === 'yes');
    else if (Array.isArray(value)) {
      const target = lookup(key, scope, ctx);
      result = op === '?=' && !target ? true : condition(value, target, nextContext(scope, target, ctx));
    } else {
      const a = lookup(key, scope, ctx), b = lookup(value, scope, ctx);
      result = ({ '=': () => a === b, '?=': () => a === b, '!=': () => a !== b,
        '>': () => a > b, '>=': () => a >= b, '<': () => a < b, '<=': () => a <= b })[op]();
    }
    if (!result) return false;
  }
  return true;
}
function branches(entries, scope, ctx, fn) {
  let taken = false;
  for (const entry of entries) {
    if (entry.key === 'if' || entry.key === 'else_if') {
      if (entry.key === 'if') taken = false;
      if (!taken && condition(field(entry.value, 'limit')?.value || [], scope, ctx)) {
        taken = true; branches(entry.value.filter(n => n.key !== 'limit'), scope, ctx, fn);
      }
    } else if (entry.key === 'else') { if (!taken) branches(entry.value, scope, ctx, fn); taken = true; }
    else fn(entry);
  }
}
function number(source, scope, ctx) {
  if (!Array.isArray(source)) return lookup(source, scope, ctx);
  let result = 0;
  branches(source, scope, ctx, ({ key, value }) => {
    const amount = number(value, scope, ctx);
    if (key === 'value') result = amount;
    else if (key === 'add') result += amount;
    else if (key === 'subtract') result -= amount;
    else if (key === 'multiply') result *= amount;
    else if (key === 'divide') { assert.notEqual(amount, 0); result /= amount; }
    else if (key === 'min') result = Math.max(result, amount);
    else if (key === 'max') result = Math.min(result, amount);
    else throw new Error(`Unsupported number operation ${key}`);
  });
  assert(Number.isFinite(result)); return result;
}
function execute(name, scope, ctx) { assert(effects.has(name), `Missing source effect ${name}`); run(effects.get(name), scope, ctx); }
function invokeOnAction(name, scope, ctx) {
  assert(onActions.has(name), `Missing source on_action ${name}`);
  const body = onActions.get(name);
  if (!condition(field(body, 'trigger')?.value || [], scope, ctx)) return;
  const action = field(body, 'effect'); if (action) run(action.value, scope, ctx);
  for (const entry of field(body, 'on_actions')?.value || []) {
    assert.equal(entry.key, null, 'Only immediate appended on_actions are supported');
    invokeOnAction(entry.value, scope, ctx);
  }
}
function run(entries, scope, ctx) {
  branches(entries, scope, ctx, ({ key, value }) => {
    if (key === 'hidden_effect') return run(value, scope, ctx);
    if (key === 'save_scope_as') { ctx.scopes[value] = scope; return; }
    if (key === 'remove_variable') { delete scope.vars[value]; return; }
    if (key === 'clear_variable_list') { scope.lists[value] = []; return; }
    if (key === 'clear_global_variable_list') { ctx.globalLists[value] = []; return; }
    if (key === 'add_to_variable_list') {
      const name = field(value, 'name').value, target = lookup(field(value, 'target').value, scope, ctx);
      (scope.lists[name] ||= []).push(target); return;
    }
    if (key === 'set_global_variable') { ctx.globals[field(value, 'name').value] = number(field(value, 'value').value, scope, ctx); return; }
    if (key === 'set_variable' || key === 'change_variable') {
      if (!Array.isArray(value)) { assert.equal(key, 'set_variable'); scope.vars[value] = 1; return; }
      const name = field(value, 'name').value;
      if (key === 'set_variable') scope.vars[name] = number(field(value, 'value').value, scope, ctx);
      else scope.vars[name] = (scope.vars[name] || 0) + number(field(value, 'add').value, scope, ctx);
      return;
    }
    if (key === 'add_character_modifier') { scope.modifiers.add(Array.isArray(value) ? field(value, 'modifier').value : value); return; }
    if (key === 'remove_character_modifier') { scope.modifiers.delete(value); return; }
    if (key === 'scriptedtests_recalculate_character_modifier') { ctx.trace.push({ native: key, scope: scope.name }); return; }
    if (key === 'vassal_contract_set_obligation_level') {
      assert.equal(field(value, 'type').value, 'teq_public_tax_obligation');
      assert.equal(field(value, 'level').value, 'teq_public_tax_standard');
      scope.contractFlags.add('teq_public_tax_contract'); ctx.trace.push({ native: key, scope: scope.name }); return;
    }
    if (['every_in_list', 'every_in_global_list', 'every_vassal_or_below', 'every_independent_ruler'].includes(key)) {
      const targets = key === 'every_vassal_or_below' ? descendants(scope)
        : key === 'every_independent_ruler' ? ctx.independentRulers
        : key === 'every_in_global_list' ? ctx.globalLists[field(value, 'variable').value] || []
        : scope.lists[field(value, 'variable').value] || [];
      for (const target of [...targets]) {
        const shifted = nextContext(scope, target, ctx);
        if (condition(field(value, 'limit')?.value || [], target, shifted)) run(value.filter(n => !['variable', 'limit'].includes(n.key)), target, shifted);
      }
      return;
    }
    if (effects.has(key) && value === 'yes') return execute(key, scope, ctx);
    if (Array.isArray(value)) {
      const target = lookup(key, scope, ctx);
      if (key && value && (!target && key !== '?=')) assert(target, `Missing scope ${key}`);
      return run(value, target, nextContext(scope, target, ctx));
    }
    throw new Error(`Unsupported effect ${key}`);
  });
}
function character(name) {
  return { name, vars: {}, lists: {}, modifiers: new Set(), contractFlags: new Set(), governmentFlags: new Set(), vassals: [], liege: null,
    has_treasury: true, realm_uses_treasury_laws_trigger: true, is_alive: true, is_landed: true, is_ai: false,
    is_independent_ruler: false, highest_held_title_tier: tiers.tier_duchy, sub_realm_size: 20 };
}
const flowModifiers = ['teq_public_tax', 'teq_refund_paused', 'teq_development_flow', 'teq_development_wealth', 'teq_military_wealth', 'teq_military_development_excluded'];
function fixture(depth = 2) {
  const central = character('unknown-treasury-center'); central.is_independent_ruler = true; central.top_liege = central;
  central.primary_title = { name: 'central-title', holder: central, vars: { teq_policy_version: 16, teq_total_budget: 0 }, lists: { teq_regions: [] } };
  central.vars.teq_policy_title = central.primary_title; central.modifiers.add('teq_central_tax'); central.modifiers.add('teq_public_collection');
  const chain = [central];
  for (let i = 1; i <= depth; i++) {
    const local = character(`unknown-treasury-region-${i}`), liege = chain.at(-1);
    local.liege = liege; local.top_liege = central; liege.vassals.push(local);
    local.primary_title = { name: `region-title-${i}`, holder: local, vars: { teq_region_owner: central.primary_title, teq_region_weight: 2, teq_region_wealth: 0 }, lists: {} };
    local.vars.teq_fiscal_owner = central.primary_title; local.vars.teq_flow_title = local.primary_title; local.vars.teq_flow_weight = 2; local.vars.teq_flow_wealth = 0;
    local.modifiers.add('teq_public_tax'); local.contractFlags.add('teq_public_tax_contract');
    central.primary_title.lists.teq_regions.push(local.primary_title); chain.push(local);
  }
  const subject = chain.at(-1), liege = subject.liege;
  return { central, chain, subject, liege, ctx: { root: subject, scopes: { subject, liege }, previous: [], gameRules: new Set(), trace: [], globals: {}, globalLists: {}, independentRulers: [central] } };
}
function check(name, scope, ctx) { assert(triggers.has(name), `Missing source trigger ${name}`); return condition(triggers.get(name), scope, ctx); }
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.stack || e.message}`); } }

test('unknown treasury chains register and remain active with zero budget or calculation locks', () => {
  for (const depth of [1, 2, 4]) {
    const f = fixture(depth);
    for (const name of ['teq_fiscal_chain_eligible', 'teq_local_flow_registered', 'teq_public_flow_active', 'teq_public_contract_active']) assert.equal(check(name, f.subject, f.ctx), true, name);
    f.central.vars.teq_review_lock = 1; f.central.vars.teq_budget_lock = 1;
    assert.equal(check('teq_public_contract_active', f.subject, f.ctx), true, 'Budget locks must not switch measured taxes off');
    execute('teq_refresh_refund_policy', f.subject, f.ctx);
    assert(f.subject.modifiers.has('teq_refund_paused'), 'A complete chain uses coordinated funding instead of native refunds');
  }
});

const breaks = [
  ['top liege has no treasury', f => { f.central.has_treasury = false; }],
  ['treasury chain breaks above the immediate liege', f => { f.chain[1].has_treasury = false; }],
  ['top treasury government has no native budget capability', f => { f.central.realm_uses_treasury_laws_trigger = false; }],
  ['central is excluded by the current scope rule', f => { f.central.is_ai = true; f.ctx.gameRules.add('teq_scope_player_only'); }],
];
test('non-treasury top or a broken fiscal chain retains native tax and immediately restores refunds', () => {
  for (const [label, change] of breaks) {
    const f = fixture(3); f.subject.modifiers.add('teq_refund_paused'); change(f);
    assert.equal(check('teq_fiscal_chain_eligible', f.subject, f.ctx), false, label);
    assert.equal(check('teq_public_contract_active', f.subject, f.ctx), false, label);
    execute('teq_refresh_refund_policy', f.subject, f.ctx);
    assert(!f.subject.modifiers.has('teq_refund_paused'), `${label}: native refund blocker remained`);
    assert(f.ctx.trace.every(t => t.native === 'scriptedtests_recalculate_character_modifier'), 'Refund recovery must not create money or alter contracts');
  }
});

test('missing registration at any layer prevents taxation and refund suppression', () => {
  const cases = [
    ['local hidden obligation missing', f => f.subject.contractFlags.clear()],
    ['local marker missing', f => f.subject.modifiers.clear()],
    ['local title missing from owner list', f => { f.central.primary_title.lists.teq_regions = f.central.primary_title.lists.teq_regions.filter(t => t !== f.subject.primary_title); }],
    ['local stale flow title', f => { f.subject.vars.teq_flow_title = f.liege.primary_title; }],
    ['local stale owner', f => { f.subject.primary_title.vars.teq_region_owner = f.liege.primary_title; }],
    ['intermediate hidden obligation missing', f => f.chain[1].contractFlags.clear()],
    ['intermediate owner registration missing', f => { delete f.chain[1].vars.teq_fiscal_owner; }],
    ['central registration missing', f => { delete f.central.vars.teq_policy_title; }],
    ['central public-collection marker missing', f => { f.central.modifiers.delete('teq_public_collection'); }],
    ['central old schema', f => { f.central.primary_title.vars.teq_policy_version = 15; }],
  ];
  for (const [label, change] of cases) {
    const f = fixture(3); change(f); f.subject.modifiers.add('teq_refund_paused');
    assert.equal(check('teq_public_contract_active', f.subject, f.ctx), false, label);
    execute('teq_refresh_refund_policy', f.subject, f.ctx);
    assert(!f.subject.modifiers.has('teq_refund_paused'), `${label}: only collecting without native refund`);
  }
});

test('an outer tributary suzerain cannot reuse a valid internal fiscal contract', () => {
  const f = fixture(2);
  f.ctx.scopes.liege = f.central;
  assert.equal(check('teq_public_contract_active', f.subject, f.ctx), false, 'Contract suzerain differs from actual direct liege');
});

test('hidden obligation initializes from eligibility without requiring prior active collection', () => {
  const f = fixture(1); f.subject.contractFlags.clear();
  assert.equal(check('teq_public_contract_active', f.subject, f.ctx), false);
  execute('teq_ensure_public_tax_obligation', f.subject, f.ctx);
  assert(f.subject.contractFlags.has('teq_public_tax_contract'));
  assert.equal(check('teq_public_contract_active', f.subject, f.ctx), true, 'New obligation must avoid bootstrap deadlock');
  const invalid = fixture(1); invalid.central.has_treasury = false; invalid.subject.contractFlags.clear();
  execute('teq_ensure_public_tax_obligation', invalid.subject, invalid.ctx);
  assert.equal(invalid.subject.contractFlags.size, 0, 'No hidden public obligation may initialize outside the fiscal chain');
});

test('native flow application registers before suppressing refunds and never pays or taxes by event', () => {
  const f = fixture(1); f.subject.modifiers.clear(); f.subject.contractFlags.clear();
  delete f.subject.vars.teq_flow_title; delete f.subject.vars.teq_fiscal_owner;
  execute('teq_apply_flow', f.subject.primary_title, f.ctx);
  assert.equal(check('teq_public_contract_active', f.subject, f.ctx), true);
  assert(f.subject.modifiers.has('teq_refund_paused'));
  const pending = fixture(1); pending.central.modifiers.clear(); pending.subject.modifiers.clear();
  execute('teq_apply_flow', pending.subject.primary_title, pending.ctx);
  assert.equal(check('teq_public_contract_active', pending.subject, pending.ctx), false);
  assert(!pending.subject.modifiers.has('teq_refund_paused'), 'Pending central activation must retain native refund');
  for (const trace of [f.ctx.trace, pending.ctx.trace]) assert(trace.every(t => ['vassal_contract_set_obligation_level', 'scriptedtests_recalculate_character_modifier'].includes(t.native)));
});

test('clearing a local flow removes every collection/development/refund modifier', () => {
  const f = fixture(1); for (const key of flowModifiers) f.subject.modifiers.add(key);
  execute('teq_clear_flow', f.subject, f.ctx);
  for (const key of flowModifiers) assert(!f.subject.modifiers.has(key), key);
  assert(!Object.hasOwn(f.subject.vars, 'teq_flow_title')); assert(!Object.hasOwn(f.subject.vars, 'teq_fiscal_owner'));
  assert.equal(check('teq_public_contract_active', f.subject, f.ctx), false);
});

function poisonFlows(f) { for (const local of f.chain.slice(1)) for (const key of flowModifiers) local.modifiers.add(key); }
function assertReleased(f) {
  for (const local of f.chain.slice(1)) {
    for (const key of flowModifiers) assert(!local.modifiers.has(key), `${local.name}: stale ${key}`);
    assert(!Object.hasOwn(local.vars, 'teq_flow_title'), `${local.name}: stale saved flow`);
    assert(!Object.hasOwn(local.vars, 'teq_fiscal_owner'), `${local.name}: stale fiscal owner`);
    assert.equal(check('teq_public_flow_active', local, f.ctx), false);
  }
  assert(!f.central.modifiers.has('teq_central_tax'), 'Old center marker remains');
  assert(!Object.hasOwn(f.central.vars, 'teq_policy_title'), 'Old central policy binding remains');
  assert.equal(f.central.primary_title.lists.teq_regions.length, 0, 'Old local roster remains');
}
test('actual government-change subtree reconciliation releases every descendant after top exits treasury', () => {
  const f = fixture(4); poisonFlows(f);
  f.central.has_treasury = false;
  f.ctx.root = f.central;
  invokeOnAction('on_government_change', f.central, f.ctx);
  assertReleased(f);
  assert(!Object.hasOwn(f.central.vars, 'teq_subtree_lock'), 'Subtree lock leaked');
  assert(!Object.hasOwn(f.central.vars, 'teq_review_lock'), 'Budget review lock leaked');
  assert.equal(f.central.lists.teq_subtree_owners.length, 0);
  assert.equal(f.central.lists.teq_subtree_locked_owners.length, 0);
});

test('an unregistered ancestor clears all real TEQ payout modifiers, then reactivates after repair', () => {
  const f = fixture(3), actual = flowModifiers.filter(key => key !== 'teq_public_tax');
  for (const key of actual) f.subject.modifiers.add(key);
  f.chain[1].contractFlags.clear();
  execute('teq_refresh_refund_policy', f.subject, f.ctx);
  assert.equal(check('teq_public_contract_active', f.subject, f.ctx), false);
  for (const key of actual) assert(!f.subject.modifiers.has(key), `Inactive chain retains ${key}`);
  assert(f.subject.modifiers.has('teq_public_tax'), 'Registration marker is kept for recovery');
  assert.equal(f.subject.vars.teq_flow_title, f.subject.primary_title);
  f.chain[1].contractFlags.add('teq_public_tax_contract');
  execute('teq_refresh_refund_policy', f.subject, f.ctx);
  for (const key of ['teq_refund_paused', 'teq_development_flow', 'teq_development_wealth']) assert(f.subject.modifiers.has(key), `Repaired civilian missing ${key}`);
  for (const key of ['teq_military_wealth', 'teq_military_development_excluded']) assert(!f.subject.modifiers.has(key));
  f.subject.contractFlags.add('province_military');
  execute('teq_refresh_refund_policy', f.subject, f.ctx);
  for (const key of ['teq_refund_paused', 'teq_military_wealth', 'teq_military_development_excluded']) assert(f.subject.modifiers.has(key), `Military role missing ${key}`);
  for (const key of ['teq_development_flow', 'teq_development_wealth']) assert(!f.subject.modifiers.has(key), `Old civilian modifier survived role change: ${key}`);
  f.subject.contractFlags.delete('province_military');
  execute('teq_refresh_refund_policy', f.subject, f.ctx);
  assert(f.subject.modifiers.has('teq_development_flow'));
  assert(!f.subject.modifiers.has('teq_military_wealth'));
});

test('actual monthly world-step cleans saved old centers before rebuilding the active-title list', () => {
  const f = fixture(4); poisonFlows(f);
  f.central.primary_title.vars.teq_private_fraction = 0.23;
  f.central.primary_title.vars.teq_retained_fraction = 0.07;
  f.central.has_treasury = false;
  f.ctx.globalLists.teq_active_titles = [f.central.primary_title];
  f.ctx.globals.teq_world_month = 11999;
  execute('teq_world_step', f.central, f.ctx);
  assertReleased(f);
  assert.equal(f.ctx.globalLists.teq_active_titles.length, 0);
  assert.equal(f.central.primary_title.vars.teq_private_fraction, 0.23, 'Player private fraction must survive cache teardown');
  assert.equal(f.central.primary_title.vars.teq_retained_fraction, 0.07, 'Player reserve fraction must survive cache teardown');
});

test('source runtime fails on unknown references, including exists and numeric input', () => {
  const f = fixture(1);
  assert.throws(() => condition([{ key: 'exists', op: '=', value: 'unknown_native_field' }], f.subject, f.ctx), /Unknown fixture\/native reference/);
  assert.throws(() => number('unknown_native_number', f.subject, f.ctx), /Unknown fixture\/native reference/);
});

console.log(`${passed}/${passed + failed} actual-source fiscal-chain/refund regressions passed`);
console.log('Native refresh/obligation setters are adapters; actual subtree/world-step source runs here, while engine cash settlement and callback delivery require in-game verification.');
if (failed) process.exitCode = 1;
