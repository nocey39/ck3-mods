// Build market profiles from the same effective data as the price catalog.
const key = (s) => /^[\w.-]+$/.test(s ?? '');
const get = (entries, field) => entries.find(([name]) => name === field)?.[1];
const sorts = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const stores = new Set(['trade_good', 'trade_good_category', 'amount', 'modifiers',
  'can_be_filled_multiple_times', 'skip_internal_fullfilment', 'skip_internal_fulfillment']);

function contains(entries, field) {
  return entries.some(([name, value]) => name === field || (Array.isArray(value) && contains(value, field)));
}

function amount(raw, constants, named) {
  const visited = new Set();
  while (typeof raw === 'string' && raw.startsWith('@') && !visited.has(raw)) {
    visited.add(raw);
    raw = constants.get(raw);
  }
  if (typeof raw !== 'string') return undefined;
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) return raw.replace(/^\+/, '');
  if (key(raw) && named.has(raw)) return raw;
  return undefined;
}

function guard(name, value) {
  if (!key(value)) return undefined;
  const terms = {
    culture_parameter: `county.culture = { has_cultural_parameter = ${value} }`,
    not_culture_parameter: `county.culture = { NOT = { has_cultural_parameter = ${value} } }`,
    rite_parameter: `county.rite = { rite_has_parameter = ${value} }`,
    not_rite_parameter: `county.rite = { NOT = { rite_has_parameter = ${value} } }`,
    government_flag: `scope:holder = { government_has_flag = ${value} }`,
    situation_parameter: `county = { has_situation_top_phase_parameter = ${value} }`,
    dynasty_perk: `scope:holder.dynasty = { has_dynasty_perk = ${value} }`,
    province_size: `province_size_level = ${value}`,
    terrain: `terrain = ${value}`,
    is_coastal: `is_coastal = ${value}`,
    is_riverside: `is_riverside_province = ${value}`,
    potential_trade_good: `county = { has_potential_for_trade_good = trade_good_type:${value} }`,
  };
  return terms[name];
}

function profile({data, constants}, resources, named, foundingFood) {
  const input = new Map(), output = new Map(), growth = [];
  let incomplete = false;
  function push(map, label, term) {
    if (!map.has(label)) map.set(label, []);
    map.get(label).push(term);
  }
  for (const [field, body] of data) {
    if (!Array.isArray(body)) continue;
    if (field === 'trade_good_need') {
      const item = get(body, 'trade_good') ?? get(body, 'trade_good_category');
      if (foundingFood && (!foundingFood.has(item) || !contains(body, 'food_supply_add'))) continue;
      const sizeLimits = foundingFood ? body.filter(([name]) => name === 'province_size') : [];
      if (sizeLimits.length) {
        if (sizeLimits.some(([, value, operation]) => operation !== '=' || !/^\d+$/.test(value))) {
          incomplete = true;
          continue;
        }
        if (sizeLimits.some(([, value]) => Number(value) !== 1)) continue;
      }
      const size = amount(get(body, 'amount') ?? '1', constants, named);
      const times = amount(get(body, 'can_be_filled_multiple_times') ?? '1', constants, named);
      const external = get(body, 'skip_internal_fullfilment') === 'yes' ||
                       get(body, 'skip_internal_fulfillment') === 'yes';
      if (!resources.has(item) || size === undefined || times === undefined) {
        incomplete = true;
        continue;
      }
      const conditions = body.filter(([name]) => !stores.has(name) &&
        !(foundingFood && name === 'province_size')).map(([name, value]) => guard(name, value));
      // Unknown input qualifiers are counted conservatively.
      const test = conditions.every(Boolean) ? conditions.sort().join(' ') : '';
      push(input, external ? `import:${item}` : item, { size, times, test });
      if (!external && conditions.every(Boolean)) {
        const effects = get(body, 'modifiers');
        const province = Array.isArray(effects) ? get(effects, 'province_modifier') : undefined;
        for (const [modifier, value] of province ?? []) {
          const production = /^(trade_good_.+)_production_(?:add|flat)$/.exec(modifier ?? '');
          const quantity = amount(value, constants, named);
          if (production && resources.has(production[1]) && quantity !== undefined) {
            push(output, production[1], { size: quantity, times, test });
          }
        }
      }
    } else if (field === 'province_modifier') {
      for (const [modifier, raw] of body) {
        const size = amount(raw, constants, named);
        if (size === undefined) continue;
        const production = /^(trade_good_.+)_production_(?:add|flat)$/.exec(modifier ?? '');
        const term = { size, times: '1', test: '' };
        if (production && resources.has(production[1])) push(output, production[1], term);
        if (modifier === 'province_size_baseline_add') growth.push(term);
      }
    }
  }
  return { input, output, growth, incomplete };
}

function difference(current = [], previous = [], clamp = true) {
  const weights = new Map();
  for (const [list, sign] of [[current, 1], [previous, -1]]) {
    for (const term of list) {
      const serialized = JSON.stringify(term);
      weights.set(serialized, (weights.get(serialized) ?? 0) + sign);
    }
  }
  const lines = [];
  for (const [serialized, weight] of weights) {
    if (!weight) continue;
    const { size, times, test } = JSON.parse(serialized);
    const count = Math.abs(weight);
    const value = count === 1 && times === '1' ? size : `{ value = ${size} multiply = ${times} multiply = ${count} }`;
    const line = `${weight > 0 ? 'add' : 'subtract'} = ${value}`;
    lines.push(test ? `if = { limit = { ${test} } ${line} }` : line);
  }
  return lines.length ? `{ value = 0 ${lines.join(' ')}${clamp ? ' min = 0' : ''} }` : '0';
}

function addMarketInputs(project, current, previous, goods, group, ledger) {
  const sum = (items) => items.length ? `{ value = 0 ${items.map(x => `add = ${x}`).join(' ')} }` : '0';
  const pools = new Map();
  let index = 0;
  for (const item of new Set([...current.keys(), ...previous.keys()])) {
    const quantity = difference(current.get(item), previous.get(item));
    if (quantity === '0') continue;
    const variable = `dau_market_trial_need_${index++}`;
    const expression = `var:${variable}`;
    project.push(`set_variable = { name = ${variable} value = ${quantity} }`);
    if (item.startsWith('import:')) {
      project.push(`if = { limit = { ${expression} > 0 } set_variable = dau_market_unquantified }`);
      continue;
    }
    const exact = goods.has(item);
    const category = exact ? group.get(item) : item;
    if (exact) {
      ledger.add(`dau_market_need_${item}`);
      if (category) ledger.add(`dau_market_wild_${category}`);
      project.push(`dau_market_exact_input_effect = { TYPE = trade_good_type:${item} ITEM = ${item} GROUP = ${category ?? 'no_category'} AMOUNT = ${expression} }`);
    }
    if (category) {
      if (!pools.has(category)) pools.set(category, { mixed: [], flexible: [] });
      pools.get(category).mixed.push(expression);
      if (!exact) pools.get(category).flexible.push(expression);
    }
  }
  for (const [category, pool] of pools) {
    ledger.add(`dau_market_need_${category}`);
    ledger.add(`dau_market_wild_${category}`);
    project.push(`set_variable = { name = dau_market_profile_total value = ${sum(pool.mixed)} }`,
      `set_variable = { name = dau_market_profile_wild value = ${sum(pool.flexible)} }`,
      `dau_market_category_input_effect = { TYPE = trade_good_category:${category} ITEM = ${category} AMOUNT = var:dau_market_profile_total WILD = var:dau_market_profile_wild }`,
      'remove_variable = dau_market_profile_total', 'remove_variable = dau_market_profile_wild');
  }
  return index;
}

function addFoundingProfiles(lines, holdings, districts, definitions, resources, named, goods, group, ledger, foodNeeds) {
  const primaries = new Set();
  for (const { data } of holdings.values()) {
    if (!Array.isArray(data)) continue;
    const district = districts.get(get(data, 'primary_district'))?.data;
    const primary = Array.isArray(district) && get(district, 'primary_building');
    if (primary && definitions.has(primary)) primaries.add(primary);
  }
  lines.push('dau_market_founding_profile_effect = {', '    switch = {', '        trigger = scope:dau_market_building');
  for (const id of [...primaries].sort(sorts)) {
    const initial = profile(definitions.get(id), resources, named, foodNeeds);
    const project = initial.incomplete ? ['set_variable = dau_market_unquantified'] : [];
    const index = addMarketInputs(project, initial.input, new Map(), goods, group, ledger);
    for (let i = 0; i < index; i++) project.push(`remove_variable = dau_market_trial_need_${i}`);
    lines.push(`        building_type:${id} = {`, ...project.map(line => '            ' + line), '        }');
  }
  lines.push('        fallback = { set_variable = dau_market_unquantified }', '    }', '}', '');
}

function generateMarkets(layers, named, destination, readDatabase) {
  const definitions = readDatabase(layers, 'common/buildings');
  const goods = readDatabase(layers, 'common/trade/trade_good_types');
  const categories = readDatabase(layers, 'common/trade/trade_good_categories');
  const districts = readDatabase(layers, 'common/districts');
  const holdings = readDatabase(layers, 'common/holdings');
  const manualStarters = new Set([...districts.values()].filter(({data}) => get(data, 'type') === 'duchy_capital')
    .map(({data}) => get(data, 'primary_building')));
  const resources = new Set([...goods.keys(), ...categories.keys()]);
  const foodGoods = new Set((get(categories.get('trade_category_food')?.data ?? [], 'trade_goods') ?? [])
    .map(([, good]) => good).filter(good => goods.has(good)));
  const foodNeeds = new Set(foodGoods);
  const group = new Map(), food = new Set(), previous = new Map(), profiles = new Map();
  for (const [category, {data}] of categories) {
    if (get(data, 'need') !== 'yes') continue;
    const members = (get(data, 'trade_goods') ?? []).map(([, good]) => good).filter(good => goods.has(good));
    for (const good of members) group.set(good, category);
    if (members.length && members.every(good => foodGoods.has(good))) foodNeeds.add(category);
  }
  for (const [id, definition] of definitions) {
    if (!Array.isArray(definition.data)) continue;
    const next = get(definition.data, 'next_building');
    if (key(next)) previous.set(next, id);
    for (const [field, body] of definition.data) {
      if (field !== 'trade_good_need' || !Array.isArray(body) || !contains(body, 'food_supply_add')) continue;
      const staple = get(body, 'trade_good_category') ?? get(body, 'trade_good');
      // A fulfilled craft need can give a local food bonus without being a food need.
      if (foodNeeds.has(staple)) food.add(staple);
    }
    profiles.set(id, profile(definition, resources, named));
  }
  const lines = ['# Generated from effective CK3 buildings, goods and need definitions.',
    'dau_market_building_profile_effect = {', '    switch = {', '        trigger = scope:dau_market_building'];
  const allProjects = new Map();
  const ledger = new Set();
  let modeled = 0, unknown = 0;
  for (const id of [...profiles.keys()].sort(sorts)) {
    const current = profiles.get(id);
    const old = profiles.get(previous.get(id)) ?? { input: new Map(), output: new Map() };
    const project = [];
    if (manualStarters.has(id)) project.push('set_variable = dau_market_manual_only');
    if (current.incomplete) {
      project.push('set_variable = dau_market_unquantified');
      unknown++;
    }
    const index = addMarketInputs(project, current.input, old.input, goods, group, ledger);
    for (const item of new Set([...current.output.keys(), ...old.output.keys()])) {
      const quantity = difference(current.output.get(item), old.output.get(item), false);
      if (quantity === '0') continue;
      const category = group.get(item);
      ledger.add(`dau_market_output_${item}`);
      if (category) ledger.add(`dau_market_output_${category}`);
      project.push(`set_variable = { name = dau_market_profile_output value = ${quantity} }`,
        `dau_market_output_effect = { TYPE = trade_good_type:${item} ITEM = ${item} AMOUNT = var:dau_market_profile_output }`);
      if (category) {
        project.push(`dau_market_category_output_effect = { TYPE = trade_good_category:${category} ITEM = ${category} FOOD = ${food.has(category) ? 'yes' : 'no'} AMOUNT = var:dau_market_profile_output }`);
      }
      project.push('remove_variable = dau_market_profile_output');
    }
    const growth = difference(current.growth, old.growth);
    if (growth !== '0') project.push(`set_variable = { name = dau_market_profile_growth value = ${growth} }`,
      'dau_market_growth_effect = { AMOUNT = var:dau_market_profile_growth }',
      'remove_variable = dau_market_profile_growth');
    for (let i = 0; i < index; i++) project.push(`remove_variable = dau_market_trial_need_${i}`);
    if (project.length) {
      modeled++;
      const signature = project.join('\n');
      if (!allProjects.has(signature)) allProjects.set(signature, []);
      allProjects.get(signature).push(id);
    }
  }
  const shared = [];
  for (const [profile, ids] of allProjects) {
    const project = profile.split('\n');
    if (ids.length === 1) {
      lines.push(`        building_type:${ids[0]} = {`, ...project.map(line => '            ' + line), '        }');
      continue;
    }
    const alias = `dau_market_profile_${shared.length + 1}_effect`;
    shared.push([`${alias} = {`, ...project.map(line => '    ' + line), '}'].join('\n'));
    for (const id of ids) lines.push(`        building_type:${id} = { ${alias} = yes }`);
  }
  lines.push('        fallback = { }', '    }', '}', '');
  addFoundingProfiles(lines, holdings, districts, definitions, resources, named, goods, group, ledger, foodNeeds);
  lines.push('dau_market_food_snapshot_effect = {');
  for (const item of [...food].sort(sorts)) {
    const exact = goods.has(item);
    const prefix = exact ? 'trade_good' : 'trade_category';
    const type = exact ? 'trade_good_type' : 'trade_good_category';
    const list = exact ? 'dau_market_requested_goods' : 'dau_market_requested_categories';
    lines.push('    if = {',
      `        limit = { ${prefix}_unfulfilled_need = { target = ${type}:${item} value > 0 } }`,
      '        scope:dau_market_anchor = {',
      '            set_variable = dau_market_food_shortage',
      `            add_to_variable_list = { name = ${list} target = ${type}:${item} }`,
      '        }',
      '    }');
  }
  lines.push('}', '', 'dau_market_initialize_flows_effect = {');
  ledger.add('dau_market_wild_no_category');
  for (const name of [...ledger].sort(sorts)) lines.push(`    set_variable = { name = ${name} value = 0 }`);
  lines.push('}', '', 'dau_market_clear_flows_effect = {');
  for (const name of [...ledger].sort(sorts)) lines.push(`    remove_variable = ${name}`);
  lines.push('    clear_variable_list = dau_market_requested_goods', '    clear_variable_list = dau_market_requested_categories',
    '    remove_variable = dau_market_food_shortage', '    remove_variable = dau_market_growth_reserved',
    '    remove_variable = dau_market_unknown_pipeline', '}');
  if (!modeled) throw new Error('No market profiles found.');
  return { destination, lines: [...lines, '', ...shared], modeled, unknown, food: food.size };
}

const taxClasses = [
  'agricultural', 'artisan', 'civic', 'commerce', 'generic', 'maritime',
  'mining', 'religious', 'tribal', 'urban', 'woodland',
];
const localTaxes = new Set(taxClasses.map(type => `monthly_${type}_tax`));
const localTaxMultipliers = new Set(['all_tax_mult', ...taxClasses.map(type => `${type}_tax_mult`)]);
const localEconomyModifiers = new Map([
  ['control_baseline_add', 'control'],
  ['popular_opinion_add', 'opinion'],
  ['province_size_baseline_add', 'growth'],
]);
const economicFields = ['tax', 'tax_conditioned', 'supply_tax', 'tax_mult', 'control', 'opinion', 'growth'];

// Modifier qualifiers apply to the county's culture, rite or holder. Use
// only modifiers that can be attributed to this province or county.
function economyModifierGuard(kind, entries) {
  if (!kind) return '';
  const scopeChecks = {
    culture: ['county.culture', 'has_cultural_parameter'],
    rite: ['county.rite', 'rite_has_parameter'],
    government: ['county.holder', 'government_has_flag'],
    terrain: ['county.culture', 'has_cultural_parameter'],
    situation: ['county', 'has_situation_top_phase_parameter'],
  };
  if (kind === 'potential_trade_good') {
    const commodity = get(entries, 'trade_good');
    return commodity && guard('potential_trade_good', commodity);
  }
  if (kind === 'dynasty') {
    const perk = get(entries, 'county_holder_dynasty_perk');
    return key(perk) ? `county.holder.dynasty ?= { has_dynasty_perk = ${perk} }` : undefined;
  }
  if (!Object.hasOwn(scopeChecks, kind)) return undefined;
  const check = scopeChecks[kind];
  const tests = [];
  for (const field of ['parameter', 'not_parameter']) {
    const param = get(entries, field);
    if (param === undefined) continue;
    if (!key(param)) return undefined;
    const [scope, trigger] = check;
    const test = `${trigger} = ${param}`;
    tests.push(`${scope} ?= { ${field === 'parameter' ? test : `NOT = { ${test} }`} }`);
  }
  if (kind === 'terrain') {
    for (const field of ['terrain', 'is_coastal', 'is_riverside']) {
      const criterion = get(entries, field);
      if (criterion === undefined) continue;
      const test = guard(field, criterion);
      if (!test) return undefined;
      tests.push(test);
    }
  }
  // Optional geographic qualifiers can all be absent. Other keyed modifiers
  // require a supported qualifier before contributing to the estimate.
  if (!tests.length && kind !== 'terrain') return undefined;
  return tests.sort(sorts).join(' ');
}

function supplyTaxTerms(entries, constants, named, { goods, categories }) {
  const good = get(entries, 'trade_good');
  const category = get(entries, 'trade_good_category');
  const hasNativeNeed = good === undefined ? categories.has(category) : category === undefined && goods.has(good);
  if (!hasNativeNeed || get(entries, 'skip_internal_fullfilment') === 'yes' ||
      get(entries, 'skip_internal_fulfillment') === 'yes') return [];
  const need = amount(get(entries, 'amount') ?? '1', constants, named);
  const times = amount(get(entries, 'can_be_filled_multiple_times') ?? '1', constants, named);
  if (need === undefined || times === undefined || Number(need) <= 0 || Number(times) <= 0) return [];
  const conditions = entries.filter(([name]) => !stores.has(name)).map(([name, value]) => guard(name, value));
  if (!conditions.every(Boolean)) return [];
  const test = conditions.sort(sorts).join(' ');
  const modifiers = get(entries, 'modifiers');
  if (!Array.isArray(modifiers)) return [];
  const terms = [];
  for (const [field, province] of modifiers) {
    if (field !== 'province_modifier' || !Array.isArray(province)) continue;
    for (const [name, raw] of province) {
      if (!localTaxes.has(name)) continue;
      const size = amount(raw, constants, named);
      if (size !== undefined && Number(size) !== 0) terms.push({ size, times, test });
    }
  }
  return terms;
}

function localEconomyProfile({ data, constants }, named, trade) {
  const fields = Object.fromEntries(economicFields.map(field => [field, []]));
  for (const [field, entries] of data) {
    if (!Array.isArray(entries)) continue;
    if (field === 'trade_good_need') {
      fields.supply_tax.push(...supplyTaxTerms(entries, constants, named, trade));
      continue;
    }
    const modifier = /^(province|county)(?:_([a-z_]+))?_modifier$/.exec(field);
    if (!modifier) continue;
    const [, scope, kind] = modifier;
    const test = economyModifierGuard(kind, entries);
    if (test === undefined) continue;
    for (const [name, raw] of entries) {
      const size = amount(raw, constants, named);
      if (size === undefined || Number(size) === 0) continue;
      let target = localEconomyModifiers.get(name);
      if (scope === 'province' && localTaxes.has(name)) target = test ? 'tax_conditioned' : 'tax';
      if (localTaxMultipliers.has(name)) target = 'tax_mult';
      if (target) fields[target].push({ size, times: '1', test });
    }
  }
  const days = amount(get(data, 'construction_time'), constants, named);
  return { fields, days };
}

function generateEconomyProfiles(layers, named, destination, readDatabase) {
  const buildings = readDatabase(layers, 'common/buildings');
  const districts = readDatabase(layers, 'common/districts');
  const holdings = readDatabase(layers, 'common/holdings');
  const trade = {
    goods: readDatabase(layers, 'common/trade/trade_good_types'),
    categories: readDatabase(layers, 'common/trade/trade_good_categories'),
  };
  const previous = new Map(), profiles = new Map(), shared = new Map();
  for (const [id, definition] of buildings) {
    if (!Array.isArray(definition.data)) continue;
    const next = get(definition.data, 'next_building');
    if (key(next)) previous.set(next, id);
    profiles.set(id, localEconomyProfile(definition, named, trade));
  }
  const lines = [
    '# Generated native building deltas. Supply tax is separate from direct local bonuses.',
    '# Base construction days precede engine speed modifiers.',
    '# Province scope. All numeric fields default to zero. Known signals a catalog entry, not a complete simulation.',
    'dau_economy_apply_building_profile_effect = {',
    ...[...economicFields, 'days'].map(field => `    set_variable = { name = dau_econ_${field} value = 0 }`),
    '    remove_variable = dau_econ_known',
    '    if = {',
    '        limit = { exists = scope:dau_economy_building }',
    '        switch = {',
    '            trigger = scope:dau_economy_building',
  ];
  let withTax = 0, withSupplyTax = 0, withDays = 0;
  for (const id of [...profiles.keys()].sort(sorts)) {
    const { fields, days } = profiles.get(id);
    const baseline = profiles.get(previous.get(id))?.fields ?? {};
    const changes = economicFields.map(field => [field, difference(fields[field], baseline[field], false)]);
    if (changes.some(([field, delta]) => field.startsWith('tax') && delta !== '0')) withTax++;
    if (changes.some(([field, delta]) => field === 'supply_tax' && delta !== '0')) withSupplyTax++;
    if (days !== undefined) {
      changes.push(['days', days]);
      withDays++;
    }
    const assignments = changes
      .filter(([, delta]) => delta !== '0')
      .map(([field, delta]) => `set_variable = { name = dau_econ_${field} value = ${delta} }`);
    const signature = assignments.join('\n');
    if (!shared.has(signature)) shared.set(signature, { assignments, ids: [] });
    shared.get(signature).ids.push(id);
  }
  const effects = [];
  let aliases = 0;
  for (const { ids, assignments } of shared.values()) {
    const statements = ['set_variable = dau_econ_known', ...assignments];
    if (ids.length === 1) {
      lines.push(`            building_type:${ids[0]} = {`, ...statements.map(line => `                ${line}`), '            }');
    } else {
      const alias = `dau_economy_profile_${++aliases}_effect`;
      effects.push('', `${alias} = {`, ...statements.map(line => `    ${line}`), '}');
      for (const id of ids) lines.push(`            building_type:${id} = { ${alias} = yes }`);
    }
  }
  lines.push('            fallback = { }', '        }', '    }', '}', '',
    '# Bind a new holding type to its native primary district building.',
    'dau_economy_bind_holding_profile_effect = {',
    '    clear_saved_scope = dau_economy_building',
    '    if = {',
    '        limit = { exists = scope:dau_economy_holding }',
    '        switch = {',
    '            trigger = scope:dau_economy_holding');
  let linkedHoldings = 0;
  for (const id of [...holdings.keys()].sort(sorts)) {
    const holding = holdings.get(id).data;
    if (!Array.isArray(holding)) continue;
    const district = districts.get(get(holding, 'primary_district'))?.data;
    if (!Array.isArray(district)) continue;
    const building = get(district, 'primary_building');
    if (!profiles.has(building)) continue;
    lines.push(`            holding_type:${id} = { building_type:${building} = { save_scope_as = dau_economy_building } }`);
    linkedHoldings++;
  }
  lines.push('            fallback = { }', '        }', '    }', '}', ...effects);
  if (!profiles.size) throw new Error('No native economic building profiles found.');
  return { destination, lines, modeled: profiles.size, withTax, withSupplyTax, withDays, linkedHoldings };
}

module.exports = { generateMarkets, generateEconomyProfiles };
