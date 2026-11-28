#!/usr/bin/env node
'use strict';

// Regression tests execute the shipped Clausewitz script, rather than a JS copy
// of its finance formulas. This deliberately small interpreter throws on every
// unsupported operation. Native engine getters are supplied as scenario inputs.
// It is not a substitute for checking income caches and recipients in CK3.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const modRoot = path.resolve(process.argv[2] || path.join(__dirname, '../treasury_equalization'));

function parse(source, filename) {
  const tokens = source.replace(/^\uFEFF/, '').match(/\s+|#[^\r\n]*|"(?:\\.|[^"\\])*"|[{}]|\?=|>=|<=|!=|[=<>]|[^\s{}=<>!?#]+/g)
    .filter(t => !/^\s|^#/.test(t));
  let i = 0;
  function entries(nested = false) {
    const result = [];
    while (i < tokens.length && tokens[i] !== '}') {
      const key = tokens[i++];
      const op = tokens[i++];
      if (!['=', '?=', '<', '<=', '>', '>=', '!='].includes(op)) {
        throw new Error(`${filename}: unsupported assignment after ${key}: ${op}`);
      }
      let value;
      if (tokens[i] === '{') {
        i++;
        value = entries(true);
      } else {
        if (tokens[i] === undefined) throw new Error(`${filename}: missing value for ${key}`);
        value = tokens[i++].replace(/^"|"$/g, '');
      }
      result.push({ key, op, value });
    }
    if (nested && tokens[i++] !== '}') throw new Error(`${filename}: unclosed block`);
    return result;
  }
  const result = entries();
  if (i !== tokens.length) throw new Error(`${filename}: unexpected closing brace`);
  return result;
}

const definitions = new Map();
for (const relative of [
  'common/script_values/teq_values.txt',
  'common/script_values/teq_private_split_values.txt',
  'common/scripted_triggers/teq_triggers.txt',
  'common/scripted_effects/teq_effects.txt',
]) {
  for (const entry of parse(fs.readFileSync(path.join(modRoot, relative), 'utf8'), relative)) {
    if (definitions.has(entry.key)) throw new Error(`duplicate definition: ${entry.key}`);
    definitions.set(entry.key, entry.value);
  }
}

const globals = { current_year: 1000, current_month: 1 };
function realm() {
  const title = { vars: {}, props: {}, holder: null };
  const ruler = { vars: {}, props: {
    monthly_character_treasury_income: 1000,
    monthly_character_treasury_balance: 100,
    character_treasury_new_budget_capacity: 900,
    character_treasury_budget_capacity: 800,
    treasury_budget_allocation_ministries: 0.5,
    treasury_budget_allocation_military: 0.4,
    treasury_budget_allocation_salaries: 0.1,
    treasury_budget_allocation_cardinal: 0,
    treasury_budget_base_rate_ministries: 1,
    treasury_budget_base_rate_military: 1,
    treasury_budget_base_rate_salaries: 1,
    treasury_budget_base_rate_cardinal: 0,
    tgp_has_access_to_ministry_trigger: false,
    treasury: 0,
  }, primary_title: title, culture: null, contractFlags: [] };
  title.holder = ruler;
  return { title, ruler };
}

function lookup(reference, scope) {
  if (typeof reference !== 'string') throw new Error('scalar reference expected');
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(reference)) return Number(reference);
  if (reference === 'yes') return true;
  if (reference === 'no') return false;
  if (reference === 'this') return scope;
  const dot = reference.indexOf('.');
  if (dot !== -1) {
    const entity = lookup(reference.slice(0, dot), scope);
    if (!entity || typeof entity !== 'object') return 0;
    return lookup(reference.slice(dot + 1), entity);
  }
  if (reference.startsWith('var:')) return scope.vars[reference.slice(4)] ?? 0;
  if (Object.hasOwn(scope, reference)) return scope[reference];
  if (Object.hasOwn(scope.props, reference)) return scope.props[reference];
  if (Object.hasOwn(globals, reference)) return globals[reference];
  if (definitions.has(reference)) return number(definitions.get(reference), scope);
  throw new Error(`unsupported reference: ${reference}`);
}

function condition(entries, scope) {
  if (!scope) return false;
  let chainTaken = false;
  for (const entry of entries) {
    const { key, op, value } = entry;
    let result;
    if (key === 'limit') continue;
    if (key === 'trigger_if' || key === 'trigger_else_if') {
      if (key === 'trigger_if') chainTaken = false;
      const limit = value.find(e => e.key === 'limit');
      const applies = !chainTaken && condition(limit?.value || [], scope);
      if (applies) {
        chainTaken = true;
        if (!condition(value.filter(e => e.key !== 'limit'), scope)) return false;
      }
      continue;
    }
    if (key === 'trigger_else') {
      if (!chainTaken && !condition(value, scope)) return false;
      continue;
    }
    if (key === 'NOT') result = !condition(value, scope);
    else if (key === 'AND') result = condition(value, scope);
    else if (key === 'OR') result = value.some(e => condition([e], scope));
    else if (key === 'always') result = value === 'yes';
    else if (key === 'has_variable') result = Object.hasOwn(scope.vars, value);
    else if (key === 'exists') {
      try { result = !!lookup(value, scope); } catch { result = false; }
    } else if (key === 'has_game_rule') result = (scope.props.gameRules || []).includes(value);
    else if (key === 'vassal_contract_has_flag') result = (scope.contractFlags || []).includes(value);
    else if (key === 'has_cultural_era_or_later') {
      const eras = ['culture_era_tribal', 'culture_era_early_medieval', 'culture_era_high_medieval', 'culture_era_late_medieval'];
      result = eras.indexOf(scope.props.era) >= eras.indexOf(value);
    } else if (definitions.has(key) && (value === 'yes' || value === 'no')) {
      result = condition(definitions.get(key), scope) === (value === 'yes');
    } else if (Array.isArray(value) && !['<', '<=', '>', '>=', '!='].includes(op)) {
      result = condition(value, lookup(key, scope));
    } else {
      const a = lookup(key, scope);
      const b = number(value, scope);
      result = ({ '=': () => a === b, '?=': () => a === b, '!=': () => a !== b,
        '<': () => a < b, '<=': () => a <= b, '>': () => a > b, '>=': () => a >= b })[op]();
    }
    if (!result) return false;
  }
  return true;
}

function runBranches(entries, scope, operation) {
  let chainTaken = false;
  for (const entry of entries) {
    if (entry.key === 'if' || entry.key === 'else_if') {
      if (entry.key === 'if') chainTaken = false;
      const limit = entry.value.find(e => e.key === 'limit');
      if (!chainTaken && condition(limit?.value || [], scope)) {
        chainTaken = true;
        runBranches(entry.value.filter(child => child.key !== 'limit'), scope, operation);
      }
    } else if (entry.key === 'else') {
      if (!chainTaken) runBranches(entry.value, scope, operation);
      chainTaken = true;
    } else operation(entry);
  }
}

function number(source, scope) {
  if (!Array.isArray(source)) return lookup(source, scope);
  let result = 0;
  runBranches(source, scope, ({ key, value }) => {
    const amount = key === 'floor' ? 0 : number(value, scope);
    switch (key) {
      case 'value': result = amount; break;
      case 'add': result += amount; break;
      case 'subtract': result -= amount; break;
      case 'multiply': result *= amount; break;
      case 'divide': assert.notEqual(amount, 0, 'script divided by zero'); result /= amount; break;
      // CK3 min/max are lower/upper clamps, respectively.
      case 'min': result = Math.max(result, amount); break;
      case 'max': result = Math.min(result, amount); break;
      case 'floor': assert.equal(value, 'yes'); result = Math.floor(result); break;
      default: throw new Error(`unsupported script-value operation: ${key}`);
    }
  });
  assert.ok(Number.isFinite(result), 'script value must be finite');
  return result;
}

function effect(source, scope) {
  runBranches(source, scope, ({ key, value }) => {
    if (key === 'hidden_effect') return effect(value, scope);
    if (key === 'set_variable' || key === 'change_variable') {
      if (!Array.isArray(value)) {
        assert.equal(key, 'set_variable');
        scope.vars[value] = 1;
        return;
      }
      const name = value.find(e => e.key === 'name')?.value;
      assert.ok(name, 'variable name is required');
      if (key === 'set_variable') scope.vars[name] = number(value.find(e => e.key === 'value').value, scope);
      else {
        const add = value.find(e => e.key === 'add');
        assert.ok(add, 'only additive change_variable is supported');
        scope.vars[name] = (scope.vars[name] || 0) + number(add.value, scope);
      }
      return;
    }
    if (key === 'remove_variable') { delete scope.vars[value]; return; }
    if (key === 'primary_title' || key === 'holder') return effect(value, lookup(key, scope));
    if (definitions.has(key) && value === 'yes') return effect(definitions.get(key), scope);
    throw new Error(`unsupported effect: ${key}`);
  });
}
const get = (key, scope) => number(definitions.get(key), scope);
const execute = (key, scope) => effect(definitions.get(key), scope);
function near(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) <= 1e-8 * Math.max(1, Math.abs(expected)), `${message}: ${actual} != ${expected}`);
}
let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`PASS ${name}`); passed++; }
  catch (error) { console.error(`FAIL ${name}: ${error.message}`); failed++; }
}

test('native spendable capacity ignores stale applied budget and intervening native enactment', () => {
  const { title, ruler } = realm();
  for (const staleApplied of [undefined, 0, 230.63537, 1e9, -1e9]) {
    if (staleApplied === undefined) delete title.vars.teq_applied_budget;
    else title.vars.teq_applied_budget = staleApplied;
    for (const balance of [-1e6, -26.29851, 0, 26, 1e6]) {
      ruler.props.monthly_character_treasury_balance = balance;
      // Native re-enactments can change the old enacted capacity independently.
      ruler.props.character_treasury_budget_capacity = Math.abs(balance) + 1;
      for (let repeat = 0; repeat < 10; repeat++) {
        execute('teq_measure_budget', title);
        near(title.vars.teq_available_flow, 900, 'current capacity');
        near(title.vars.teq_total_budget, 855, '95% budget stays stable');
        near(title.vars.teq_retained_flow, 45, '5% retained stays stable');
      }
    }
  }
});

test('reserve endpoints, zero capacity and uncached getter use native net funds', () => {
  const { title, ruler } = realm();
  near(get('teq_budget_ceiling', ruler), 855, 'uncached fallback excludes non-budget expenses');
  for (const [reserve, capacity, expected] of [[0, 900, 900], [1, 900, 0], [0.05, 0, 0], [0.05, -10, 0]]) {
    title.vars.teq_retained_fraction = reserve;
    ruler.props.character_treasury_new_budget_capacity = capacity;
    execute('teq_measure_budget', title);
    near(title.vars.teq_total_budget, expected, 'boundary budget');
    assert.ok(title.vars.teq_retained_flow >= 0);
  }
});

test('wealthy civilian development floor is continuous and retains at least 7.5% of base need', () => {
  const { ruler } = realm();
  ruler.vars.teq_admin_counties = 1;
  const target = get('teq_local_target_value', ruler);
  let previous = Infinity;
  for (const ratio of [-1, 0, 1, 1.849, 1.85, 1.851, 2, 10]) {
    ruler.props.treasury = ratio * target;
    const pressure = get('teq_pressure_value', ruler);
    ruler.vars.teq_flow_wealth = get('teq_wealth_value', ruler);
    const effectiveShare = pressure * (1 - get('teq_dev_wealth_scale', ruler));
    assert.ok(pressure <= previous + 1e-10, 'pressure must never rise with wealth');
    assert.ok(effectiveShare >= 0.075 - 1e-10, 'civilian base development floor');
    previous = pressure;
  }
  ruler.props.treasury = 1.849999 * target;
  const before = get('teq_pressure_value', ruler);
  ruler.props.treasury = 1.850001 * target;
  const after = get('teq_pressure_value', ruler);
  assert.ok(Math.abs(before - after) < 0.00001, 'no discontinuity at former cutoff');
});

test('development cap includes native recipients even with zero TEQ need sum', () => {
  const { title, ruler } = realm();
  title.vars.teq_public_budget = 207.57273;
  title.vars.teq_native_development_units = 8.5;
  title.vars.teq_need_sum = 0;
  const cap = get('teq_development_base_rate_cap', ruler);
  assert.ok(cap > 0, 'native ministry recipients must keep their channel');
  near(cap * 8.5, 211.7241846, '2% headroom on public budget');
  title.vars.teq_need_sum = 1e8;
  near(get('teq_development_base_rate_cap', ruler), cap, 'TEQ cache is not the native denominator');
  for (const units of [0, -1, undefined]) {
    if (units === undefined) delete title.vars.teq_native_development_units;
    else title.vars.teq_native_development_units = units;
    near(get('teq_development_base_rate_cap', ruler), 0, 'missing/zero receivers cannot divide');
  }
});

test('salary curve advances once per real month regardless of repeated recalibration', () => {
  const { title } = realm();
  globals.current_month = 1;
  title.vars.teq_total_budget = 1000;
  title.vars.teq_salary_units = 10;
  execute('teq_review_salary_tier', title);
  near(title.vars.teq_salary_curve_factor, 1.75, 'initial native-office salary target');
  title.vars.teq_total_budget = 2000;
  for (let i = 0; i < 100; i++) execute('teq_review_salary_tier', title);
  near(title.vars.teq_salary_curve_factor, 1.75, 'same month must not accelerate');
  const target = get('teq_salary_curve_target_value', title);
  globals.current_month = 2;
  execute('teq_review_salary_tier', title);
  near(title.vars.teq_salary_curve_factor, (3 * 1.75 + target) / 4, 'next month takes one 25% step');
  const next = title.vars.teq_salary_curve_factor;
  for (let i = 0; i < 100; i++) execute('teq_review_salary_tier', title);
  near(title.vars.teq_salary_curve_factor, next, 'second month repeats stay stable');
});

console.log(`${passed}/${passed + failed} source-script finance regressions passed (${modRoot})`);
if (failed) process.exitCode = 1;
