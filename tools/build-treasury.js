#!/usr/bin/env node
'use strict';

// Build into a NEW directory. Never installs a mod or edits a playset/save.
// node tools/build-treasury.js --game <CK3/game> [--user-dir <CK3 user>] --output <new bundle>
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { generate, parse } = require('./generate-universal-tax.js');
const args = process.argv.slice(2), options = {};
try {
  for (let i = 0; i < args.length; i += 2) {
    assert(['--game', '--user-dir', '--output'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--'),
      'Usage: --game <CK3/game> [--user-dir <CK3 user>] --output <new bundle>');
    assert(!options[args[i]], `Repeated option ${args[i]}`);
    options[args[i]] = args[i + 1];
  }
  assert(options['--game'] && options['--output'], '--game and --output are required');
  const source = path.resolve(__dirname, '../treasury_equalization');
  const bundle = path.resolve(options['--output']);
  assert(!fs.existsSync(bundle), 'Output already exists. Choose a new directory so an installed mod is never overwritten.');
  const relative = path.relative(source, bundle);
  assert(relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'Output must be outside the source mod.');
  // Check ALL installed input roots before the first write, even TEQ layers
  // that the generator will exclude from its merge.
  const game = path.resolve(options['--game']);
  assert(fs.existsSync(path.join(game, 'common/subject_contracts')), '--game must point to a CK3 game directory');
  const protectedRoots = [source, game];
  if (options['--user-dir']) {
    const user = path.resolve(options['--user-dir']);
    protectedRoots.push(user);
    const load = JSON.parse(fs.readFileSync(path.join(user, 'dlc_load.json'), 'utf8'));
    assert(Array.isArray(load.enabled_mods), 'dlc_load.json must contain enabled_mods');
    for (const entry of load.enabled_mods) {
      assert.equal(typeof entry, 'string', 'Enabled mod paths must be strings');
      const file = path.isAbsolute(entry) ? entry : path.resolve(user, entry);
      const ast = parse(fs.readFileSync(file, 'utf8'), 'enabled mod descriptor');
      const last = key => ast.filter(n => n.key === key).at(-1)?.value;
      assert(!last('archive'), 'Archive mods require extraction before building');
      const raw = last('path');
      assert.equal(typeof raw, 'string', 'Enabled mod has no directory path');
      const value = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(["\\])/g, '$1') : raw;
      protectedRoots.push(path.isAbsolute(value) ? value : path.resolve(user, value));
    }
  }
  function canonical(filename) {
    let ancestor = filename;
    const suffix = [];
    while (!fs.existsSync(ancestor)) {
      suffix.unshift(path.basename(ancestor));
      const parent = path.dirname(ancestor);
      assert.notEqual(parent, ancestor, 'Cannot resolve output ancestry');
      ancestor = parent;
    }
    return path.join(fs.realpathSync(ancestor), ...suffix);
  }
  const resolvedBundle = canonical(bundle);
  for (const root of protectedRoots) {
    const within = path.relative(canonical(root), resolvedBundle);
    assert(within && (within.startsWith('..' + path.sep) || path.isAbsolute(within)),
      'Output must be outside the game, CK3 user directory and every enabled mod, including older TEQ builds.');
  }
  const mod = path.join(bundle, 'treasury_equalization');
  fs.mkdirSync(mod, { recursive: true });
  // Copy runtime scripts, not a contract snapshot from an earlier build.
  fs.cpSync(source, mod, {
    recursive: true,
    filter: filename => !['common/subject_contracts', 'manifest.json'].includes(path.relative(source, filename).replaceAll('\\', '/')),
  });
  const manifest = generate({ game: options['--game'], userDir: options['--user-dir'], output: mod });
  const descriptorPath = path.join(mod, 'descriptor.mod');
  let descriptor = fs.readFileSync(descriptorPath, 'utf8');
  assert(/replace_path\s*=\s*"common\/subject_contracts"/.test(descriptor), 'Source descriptor must declare the generated replacement database.');
  descriptor = descriptor.replace(/^path\s*=.*\r?\n?/gm, '').trimEnd();
  fs.writeFileSync(descriptorPath, descriptor + '\n', 'utf8');
  fs.writeFileSync(path.join(bundle, 'treasury_equalization.mod'),
    descriptor + '\npath="' + mod.replaceAll('\\', '/') + '"\n', 'utf8');
  fs.writeFileSync(path.join(bundle, 'INSTALL.txt'),
    '国库统筹财政 0.7.6\n\n' +
    '此目录按生成时的游戏与启用模组构建。放在所有其他模组之后加载。\n' +
    '游戏更新、模组更新、增删或调整顺序后，请重新构建。\n' +
    '不要同时启用创意工坊版和本地版。关闭游戏并备份旧模组后再替换。\n' +
    '本工具没有改动游戏目录、启用列表、已安装模组或存档。\n' +
    '本地 .mod 指针包含本机生成路径；移动目录后需要更新 path。\n', 'utf8');
  console.log(JSON.stringify({ ok: true, ...manifest.counts, requiredPosition: manifest.policy.requiredPosition }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
