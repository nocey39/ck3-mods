const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { generateMarkets, generateEconomyProfiles } = require('./generate-market-profiles.cjs');

const currencies = new Map([
  ['gold', 'GOLD'], ['treasury', 'TREASURY'], ['treasury_or_gold', 'FLEX_GOLD'],
  ['prestige', 'PRESTIGE'], ['piety', 'PIETY'], ['influence', 'INFLUENCE'],
]);
const numeric = /^\+?(?:\d+(?:\.\d*)?|\.\d+)$/;
const scriptKey = /^[A-Za-z0-9_.-]+$/;
const operator = /^(?:[<>!?=]=|[<>=])$/;
const asciiCompare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function parse(source, filename) {
  const tokens = [...source.replace(/^\uFEFF/, '').matchAll(/"(?:\\.|[^"\\])*"|#[^\r\n]*|[<>!?=]=|[{}<>=]|[^{}<>=!?\s"#]+|[!?]/g)]
    .map(([token]) => token).filter((token) => !token.startsWith('#'));
  let cursor = 0;
  function readBlock(nested) {
    const entries = [];
    while (cursor < tokens.length) {
      const key = tokens[cursor++];
      if (key === '}') {
        if (!nested) throw new Error(`Unexpected closing brace in ${filename}`);
        return entries;
      }
      if (!operator.test(tokens[cursor] ?? '')) {
        entries.push([null, key === '{' ? readBlock(true) : key]);
        continue;
      }
      const operation = tokens[cursor++];
      const value = tokens[cursor++];
      if (value === undefined || value === '}') throw new Error(`Missing value for ${key} in ${filename}`);
      entries.push([unquote(key), value === '{' ? readBlock(true) : unquote(value), operation]);
    }
    if (nested) throw new Error(`Unclosed block in ${filename}`);
    return entries;
  }
  return readBlock(false);
}

function unquote(value) {
  return value.startsWith('"') ? value.slice(1, -1) : value;
}

function readEntries(filename) {
  return parse(fs.readFileSync(filename, 'utf8'), filename);
}

function hasDirectory(directory) {
  return Boolean(directory && fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory());
}

function effectiveFiles(layers, folder) {
  const files = new Map();
  function walk(root, relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const item = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(root, item);
      else if (entry.isFile() && /\.txt$/i.test(entry.name)) files.set(item.toLowerCase(), path.join(root, item));
    }
  }
  for (const { root, replacePaths = [] } of layers) {
    for (const replacement of replacePaths) {
      const normalized = replacement.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '').toLowerCase();
      for (const key of files.keys()) {
        if (key === normalized || key.startsWith(`${normalized}/`)) files.delete(key);
      }
    }
    if (hasDirectory(path.join(root, folder))) walk(root, folder);
  }
  return [...files].sort(([left], [right]) => asciiCompare(left, right)).map(([, filename]) => filename);
}

function readDatabase(layers, folder) {
  const definitions = new Map();
  for (const filename of effectiveFiles(layers, folder)) {
    const entries = readEntries(filename);
    const constants = new Map(entries.filter(([key]) => key?.startsWith('@')));
    for (const [key, data] of entries) {
      if (key && scriptKey.test(key)) definitions.set(key, { data, constants, filename });
    }
  }
  return definitions;
}

function parseModDescriptor(filename, userRoot) {
  const entries = readEntries(filename);
  const location = entries.find(([key]) => key === 'path')?.[1];
  if (!location || !hasDirectory(path.resolve(userRoot, location))) {
    throw new Error(`Cannot resolve enabled mod directory from ${filename}. Directory-based mods are supported.`);
  }
  const root = path.resolve(userRoot, location);
  const internal = path.join(root, 'descriptor.mod');
  const replacePaths = [...entries, ...(fs.existsSync(internal) ? readEntries(internal) : [])]
    .filter(([key, value]) => key === 'replace_path' && typeof value === 'string').map(([, value]) => value);
  return { root, replacePaths };
}

function playsetLayers(userRoot) {
  const launcherDb = path.join(userRoot, 'launcher-v2.sqlite');
  if (!fs.existsSync(launcherDb)) return lastLaunchLayers(userRoot);
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(launcherDb, { readOnly: true });
  try {
    const active = database.prepare('select id from playsets where isActive=1 and coalesce(isRemoved, 0)=0').all();
    if (active.length === 0) return lastLaunchLayers(userRoot);
    if (active.length !== 1) throw new Error('The launcher has more than one active playset. Select one playset first.');
    const mods = database.prepare(`select m.name, m.gameRegistryId, m.dirPath, m.archivePath
      from playsets_mods p join mods m on m.id=p.modId
      where p.playsetId=? and p.enabled=1 order by p.position asc, p.modId asc`).all(active[0].id);
    return mods.map((mod) => {
      const descriptor = mod.gameRegistryId && path.resolve(userRoot, mod.gameRegistryId);
      if (descriptor && /\.mod$/i.test(descriptor) && fs.existsSync(descriptor)) {
        return parseModDescriptor(descriptor, userRoot);
      }
      const directory = mod.dirPath && path.resolve(userRoot, mod.dirPath);
      if (!hasDirectory(directory)) {
        throw new Error(`The enabled mod '${mod.name}' has no readable directory. Resolve its launcher entry before refreshing prices.`);
      }
      const internal = path.join(directory, 'descriptor.mod');
      const replacePaths = fs.existsSync(internal) ? readEntries(internal)
        .filter(([key, value]) => key === 'replace_path' && typeof value === 'string').map(([, value]) => value) : [];
      return { root: directory, replacePaths };
    });
  } finally {
    database.close();
  }
}

function lastLaunchLayers(userRoot) {
  const filename = path.join(userRoot, 'dlc_load.json');
  if (!fs.existsSync(filename)) return [];
  const config = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(config.enabled_mods)) throw new Error(`Invalid playset list in ${filename}`);
  return config.enabled_mods.map((entry) => parseModDescriptor(path.resolve(userRoot, entry), userRoot));
}

function supportedCost(value, constants, namedValues) {
  const visited = new Set();
  while (typeof value === 'string' && value.startsWith('@') && !visited.has(value)) {
    visited.add(value);
    value = constants.get(value);
  }
  if (typeof value !== 'string') return undefined;
  if (numeric.test(value)) return value.replace(/^\+/, '');
  return scriptKey.test(value) && namedValues.has(value) ? value : undefined;
}

function classify(entries) {
  const flags = entries.filter(([key]) => key === 'flag').map(([, value]) => value);
  const names = new Set(entries.map(([key]) => key));
  for (const [key, value] of entries) {
    if (key?.endsWith('_modifier') && Array.isArray(value)) {
      for (const [modifier] of value) names.add(modifier);
    }
  }
  if (flags.some((flag) => /^(?:defense|defence|fortification)$/.test(flag)) || [...names].some((key) => key && /^(?:fort_level|garrison_size|garrison_reinforcement_factor)$/.test(key))) return 3;
  if (flags.some((flag) => /^(?:economy|economic|trade)$/.test(flag)) || [...names].some((key) => key && /(?:tax|income|production|trade_capacity)/.test(key))) return 1;
  if (flags.some((flag) => /^(?:military|army)$/.test(flag)) || [...names].some((key) => key && /(?:levy|levies|men_at_arms|regiment)/.test(key))) return 2;
  return 0;
}

function buildingQuote(definition, namedValues) {
  const { data, constants } = definition;
  if (!Array.isArray(data)) return undefined;
  const fields = new Map(data);
  if (fields.get('is_graphical_background') === 'yes') return undefined;
  const costs = new Map(data.filter(([key]) => key?.startsWith('cost_')).map(([key, value]) => [
    key === 'cost_gold' ? 'treasury_or_gold' : key.slice(5), value,
  ]));
  if (fields.has('cost')) {
    const costBlock = fields.get('cost');
    if (!Array.isArray(costBlock)) return undefined;
    for (const [key, value] of costBlock) {
      if (costs.has(key)) return undefined;
      costs.set(key, value);
    }
  }
  const quote = Object.fromEntries([...currencies.values()].map((currency) => [currency, '0']));
  for (const [key, value] of costs) {
    const currency = currencies.get(key);
    const amount = supportedCost(value, constants, namedValues);
    if (!currency || amount === undefined) return undefined;
    quote[currency] = amount;
  }
  quote.CATEGORY = classify(data);
  return quote;
}

function writeCatalogs(catalogs) {
  const changes = [];
  try {
    for (const { destination, lines } of catalogs) {
      const next = Buffer.from(`\uFEFF${[...lines, ''].join('\n')}`, 'utf8');
      const previous = fs.existsSync(destination) ? fs.readFileSync(destination) : null;
      if (previous?.equals(next)) continue;
      const temp = `${destination}.${process.pid}.tmp`;
      fs.writeFileSync(temp, next, { flag: 'wx' });
      changes.push({ destination, previous, temp, applied: false });
    }
    for (const change of changes) {
      fs.renameSync(change.temp, change.destination);
      change.applied = true;
    }
  } catch (error) {
    for (const { destination, previous, temp, applied } of changes.reverse()) {
      if (!applied) continue;
      if (previous) {
        fs.writeFileSync(temp, previous, { flag: 'wx' });
        fs.renameSync(temp, destination);
      } else fs.unlinkSync(destination);
    }
    throw error;
  } finally {
    for (const { temp } of changes) if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return changes.length > 0;
}

const districtSlotEffects = new Map([
  ['regular', 'dau_land_native_note_empty_regular_district_slot_effect'],
  ['resource', 'dau_land_native_note_empty_resource_district_slot_effect'],
  ['duchy_capital', 'dau_land_native_note_empty_duchy_capital_district_slot_effect'],
  ['special', 'dau_land_native_note_empty_special_district_slot_effect'],
  ['great_district', 'dau_land_native_note_empty_great_district_slot_effect'],
  ['entrepot', 'dau_land_native_note_empty_entrepot_district_slot_effect'],
  ['trade_post', 'dau_land_native_note_empty_trade_post_district_slot_effect'],
]);

function districtSlotChecks(districts) {
  const checks = new Map();
  for (const [district, { data }] of districts) {
    if (!Array.isArray(data)) continue;
    const primary = data.find(([key]) => key === 'primary_building')?.[1];
    if (typeof primary !== 'string') continue;
    const fields = new Map(data);
    const slotType = fields.get('type') ?? 'regular';
    const effect = districtSlotEffects.get(slotType);
    if (!effect) continue;
    const guard = ` ${effect} = yes`;
    checks.set(primary, (checks.get(primary) ?? '') + guard);
  }
  return checks;
}

function generateLand(layers, namedValues, destination) {
  const definitions = readDatabase(layers, 'common/buildings');
  const districts = readDatabase(layers, 'common/districts');
  const slotChecks = districtSlotChecks(districts);
  const holdingBases = new Set();
  const holdingPrimaries = new Set();
  for (const { data } of districts.values()) {
    if (!Array.isArray(data)) continue;
    const fields = new Map(data);
    if (fields.get('type') !== 'holding') continue;
    let building = fields.get('primary_building');
    if (building) holdingBases.add(building);
    while (building && !holdingPrimaries.has(building)) {
      holdingPrimaries.add(building);
      building = definitions.get(building)?.data?.find?.(([key]) => key === 'next_building')?.[1];
    }
  }
  const lines = ['# Generated from the effective CK3 building definitions. Do not edit.',
    'dau_land_native_quote_effect = {', '    switch = {', '        trigger = scope:dau_native_building'];
  let known = 0;
  let skipped = 0;
  for (const [name, definition] of [...definitions].sort(([a], [b]) => asciiCompare(a, b))) {
    const quote = holdingBases.has(name) ? undefined : buildingQuote(definition, namedValues);
    if (!quote) { skipped++; continue; }
    if (holdingPrimaries.has(name)) quote.CATEGORY = 0;
    const parameters = Object.entries(quote).map(([key, value]) => `${key} = ${value}`).join(' ');
    lines.push(`        building_type:${name} = { dau_land_native_apply_quote_effect = { ${parameters} } dau_land_native_check_base_slot_effect = { BUILDING = ${name} }${slotChecks.get(name) ?? ''} }`);
    known++;
  }
  if (!known) throw new Error('No usable building definitions were found. The existing catalog was preserved.');
  lines.push('        fallback = { dau_land_native_quote_adapter_effect = yes }', '    }', '}');
  return { known, skipped, catalog: { destination, lines } };
}

function renderAtom(value, constants) {
  if (value.startsWith('@')) {
    const scalar = supportedCost(value, constants, new Set());
    if (scalar === undefined) throw new Error('Unknown file-scoped constant');
    return scalar;
  }
  return /^[\w.:+/$|\-[\]]+$/.test(value) ? value : `"${value}"`;
}

function renderBlock(entries, constants) {
  const text = entries.map(([key, value, operation]) => {
    const rendered = Array.isArray(value) ? renderBlock(value, constants) : renderAtom(value, constants);
    return key === null ? rendered : `${renderAtom(key, constants)} ${operation} ${rendered}`;
  });
  return `{ ${text.join(' ')} }`;
}

function domicileOffer(name, definition, definitions, namedValues) {
  const { data, constants } = definition;
  if (!Array.isArray(data)) return undefined;
  const fields = new Map(data);
  const types = fields.get('allowed_domicile_types');
  const slot = fields.get('slot_type') ?? 'external';
  const previous = fields.get('previous_building');
  const parent = definitions.get(previous)?.data;
  if (!Array.isArray(types) || !types.length || types.some(([key, type]) => key !== null || !scriptKey.test(type))) return undefined;
  if ((previous && !Array.isArray(parent)) || (!previous && slot !== 'external')) return undefined;
  if (!['main', 'external', 'internal'].includes(slot)) return undefined;
  const gate = `OR = { ${types.map(([, type]) => `is_domicile_type = ${type}`).join(' ')} }`;
  const requirements = [gate, `NOT = { has_domicile_building_or_higher = ${name} }`];
  if (!previous) requirements.push('free_external_domicile_building_slots > 0');
  else if (slot === 'internal' && parent.find(([key]) => key === 'slot_type')?.[1] !== 'internal') {
    requirements.push(`has_domicile_building_or_higher = ${previous}`, `domicile_building_has_free_internal_slot = ${previous}`);
  } else requirements.push(`has_domicile_building = ${previous}`);

  const quote = Object.fromEntries([...currencies.values(), 'HERD'].map((currency) => [currency, '0']));
  const computedCosts = [];
  const costs = fields.get('cost') ?? [];
  if (!Array.isArray(costs)) return undefined;
  try {
    for (const [key, value] of costs) {
      const currency = key === 'herd' ? 'HERD' : currencies.get(key);
      if (!currency) return undefined;
      let amount;
      if (Array.isArray(value)) {
        const signature = createHash('sha256').update(`${name}:${currency}`).digest('hex').slice(0, 20);
        amount = `dau_native_domicile_cost_${signature}`;
        computedCosts.push(`${amount} = ${renderBlock(value, constants)}`);
      } else amount = supportedCost(value, constants, namedValues);
      if (amount === undefined) return undefined;
      quote[currency] = amount;
    }
    const characterChecks = ['can_construct_potential', 'can_construct'].map((key) => fields.get(key)).filter(Boolean)
      .map((conditions) => `AND = ${renderBlock(conditions, constants)}`);
    const dlc = fields.get('requires_dlc_flag');
    if (dlc && scriptKey.test(dlc)) characterChecks.push(`has_dlc_feature = ${dlc}`);
    return { gate, computedCosts, conditions: `domicile = { ${requirements.join(' ')} } ${characterChecks.join(' ')}`,
      parameters: Object.entries(quote).map(([key, value]) => `${key} = ${value}`).join(' '), main: slot === 'main' ? 1 : 0 };
  } catch {
    return undefined;
  }
}

function generateDomicile(layers, namedValues, targetMod, destination) {
  const legacy = path.join(targetMod, 'common', 'scripted_effects', 'dau_generated_construction.txt');
  if (!fs.existsSync(legacy)) return { count: 0, catalogs: [] };
  const previouslySupported = new Set([...fs.readFileSync(legacy, 'utf8').matchAll(/^\s*flag:([A-Za-z0-9_.-]+)\s*=\s*\{/gm)].map(([, name]) => name));
  const definitions = readDatabase(layers, 'common/domiciles/buildings');
  const gates = new Set();
  const offers = [];
  const starts = [];
  const prices = ['# Generated conditional domicile prices. Evaluated in the owner character scope.'];
  for (const [name, definition] of definitions) {
    if (previouslySupported.has(name)) continue;
    const offer = domicileOffer(name, definition, definitions, namedValues);
    if (!offer) continue;
    gates.add(offer.gate);
    prices.push(...offer.computedCosts);
    offers.push(`    if = { limit = { ${offer.conditions} } dau_native_domicile_consider_effect = { BUILDING = ${name} MAIN = ${offer.main} ${offer.parameters} } }`);
    starts.push(`        flag:${name} = { if = { limit = { ${offer.conditions} } dau_native_domicile_start_effect = { BUILDING = ${name} ${offer.parameters} } } }`);
  }
  const lines = ['# Generated from CK3 domicile definitions.', 'dau_native_domicile_scan_effect = {'];
  if (gates.size) lines.push(`    if = { limit = { domicile = { OR = { ${[...gates].join(' ')} } } }`, ...offers.map((entry) => `    ${entry}`), '    }');
  lines.push('    dau_domicile_registered_adapter_scan_effect = yes', '}', 'dau_native_domicile_execute_effect = {',
    '    switch = { trigger = var:dau_candidate', ...starts,
    '        fallback = { dau_domicile_registered_adapter_execute_effect = yes }', '    }', '}');
  return { count: offers.length, catalogs: [
    { destination: path.join(targetMod, 'common', 'script_values', 'dau_domicile_native_prices.txt'), lines: prices },
    { destination, lines },
  ] };
}

function generateAutomaticDomicileChoices(effects) {
  const choices = new Map(readEntries(path.join(effects, 'dau_choice_effects.txt')));
  const selection = new Map(readEntries(path.join(effects, 'dau_generated_selection.txt')));
  const routes = selection.get('dau_scan_routes_effect');
  const regularOffers = new Set(routes.flatMap(([, route]) => route.map(([effect]) => effect)));
  const choiceSwitch = new Map(choices.get('dau_execute_choice_effect')).get('switch');
  const offers = choiceSwitch
    .filter(([key]) => key.startsWith('flag:'))
    .map(([key]) => `dau_consider_${key.slice('flag:'.length)}`)
    .filter((effect) => !regularOffers.has(effect));
  for (const effect of offers) {
    if (!selection.has(effect)) throw new Error(`Missing domicile construction candidate: ${effect}`);
  }
  return {
    destination: path.join(effects, 'dau_automatic_choices.txt'),
    lines: [
      '# Generated from the existing choice events and ordinary construction routes.',
      'dau_scan_automatic_choices_effect = {',
      ...offers.map((effect) => `    ${effect} = yes`),
      '}',
    ],
  };
}

function generateAdapters(mods, destination) {
  const quotes = [];
  const adapters = { land: new Map(), domicile: new Map() };
  const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
  for (const { root } of mods) {
    const filename = path.join(root, 'dau-adapter.json');
    if (!fs.existsSync(filename)) continue;
    const config = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
    if (config.landQuote !== undefined) {
      if (typeof config.landQuote !== 'string' || !identifier.test(config.landQuote)) {
        throw new Error(`Invalid landQuote callback in ${filename}`);
      }
      quotes.push(config.landQuote);
    }
    for (const [scope, callbacks] of Object.entries(adapters)) {
      if (config[scope] === undefined) continue;
      const { id, scan, execute } = config[scope];
      if (![id, scan, execute].every((name) => typeof name === 'string' && identifier.test(name)) || callbacks.has(id)) {
        throw new Error(`Invalid or duplicate ${scope} adapter in ${filename}`);
      }
      callbacks.set(id, { scan, execute });
    }
  }
  const lines = ['# Generated from enabled mods that provide dau-adapter.json.', 'dau_land_registered_quote_effect = {'];
  for (const quote of quotes) lines.push(`    if = { limit = { NOT = { has_variable = dau_land_q_valid } } ${quote} = yes }`);
  lines.push('}');
  for (const [scope, callbacks] of Object.entries(adapters)) {
    lines.push(`dau_${scope}_registered_adapter_scan_effect = {`);
    for (const { scan } of callbacks.values()) lines.push(`    ${scan} = yes`);
    lines.push('}', `dau_${scope}_registered_adapter_execute_effect = {`);
    if (callbacks.size || scope === 'land') {
      lines.push(`    switch = { trigger = var:${scope === 'land' ? 'dau_land_candidate' : 'dau_candidate'}`);
      for (const [id, { execute }] of callbacks) lines.push(`        flag:dau_adapter_${id} = { ${execute} = yes }`);
      if (scope === 'land') lines.push('        fallback = { set_variable = { name = dau_land_status value = 5 } set_variable = dau_land_stop }');
      lines.push('    }');
    }
    lines.push('}');
  }
  return { destination, lines };
}

function main([gameRoot, targetMod, userRoot, mode, ...overrides]) {
  if (!gameRoot || !targetMod || !userRoot || !['--playset', '--vanilla', '--layers'].includes(mode)) {
    throw new Error('Usage: node refresh-florin-quotes.cjs <game data> <target mod> <CK3 user folder> --playset|--vanilla|--layers [mod directories]');
  }
  if (!hasDirectory(path.join(gameRoot, 'common', 'buildings'))) throw new Error('CK3 game data folder not found.');
  const effects = path.join(targetMod, 'common', 'scripted_effects');
  const mods = mode === '--playset' ? playsetLayers(userRoot) : overrides.map((root) => ({ root }));
  const layers = [{ root: gameRoot }, ...mods];
  const namedValues = readDatabase(layers, 'common/script_values');
  const result = generateLand(layers, namedValues, path.join(effects, 'dau_land_native_quotes.txt'));
  const domicile = generateDomicile(layers, namedValues, targetMod, path.join(effects, 'dau_domicile_native_catalog.txt'));
  const adapters = generateAdapters(mods, path.join(effects, 'dau_playset_adapters.txt'));
  const automaticChoices = generateAutomaticDomicileChoices(effects);
  const market = generateMarkets(layers, namedValues, path.join(effects, 'dau_market_profiles.txt'), readDatabase);
  const economy = generateEconomyProfiles(layers, namedValues, path.join(effects, 'dau_economy_profiles.txt'), readDatabase);
  const updated = writeCatalogs([result.catalog, ...domicile.catalogs, adapters, automaticChoices, market, economy]);
  console.log(`${result.known} land quotes, ${result.skipped} skipped, ${domicile.count} additional domicile buildings, ${mods.length} enabled mod layers. ${updated ? 'Catalogs refreshed.' : 'Catalogs current.'}`);
}

module.exports = { generateMarkets, readDatabase, writeCatalogs, playsetLayers, districtSlotChecks };

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
