import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = jsFiles(join(ROOT, 'public'));

/**
 * 浏览器里的模块没有任何东西帮忙编译：少一个文件、多打一个 `const`，
 * 页面只会卡在「加载中…」，测试全绿也照样发现不了（`909d370` 就这么把称重台弄黑过一页）。
 * 所以这里逐个语法检查，并确认每个 import 指的文件真的在 public 下。
 */
test('public 下的前端脚本语法都过得去', () => {
  const broken = [];
  for (const file of files) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
      broken.push(`${file}: ${String(err.stderr || err.message).split('\n')[0]}`);
    }
  }
  assert.deepEqual(broken, []);
});

test('import 指向的文件都在 public 下，没有一个空引用', () => {
  const missing = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const match of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const spec = match[1];
      const target = spec.startsWith('/')
        ? join(ROOT, 'public', spec)
        : spec.startsWith('.')
          ? resolve(dirname(file), spec)
          : null;
      if (!target) continue;
      try {
        if (!statSync(target).isFile()) missing.push(`${file} → ${spec}`);
      } catch {
        missing.push(`${file} → ${spec}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});
