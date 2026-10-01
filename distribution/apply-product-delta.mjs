#!/usr/bin/env node
/**
 * Applies the PiCode product delta to a VSCodium `product.json`.
 *
 * The delta is data (`distribution/product-delta.json`); this program is the
 * only mechanism that interprets it. The product file is deliberately NOT
 * rewritten by PowerShell: Windows PowerShell 5.1 caps `ConvertTo-Json` depth at
 * 2 and escapes non-ASCII, which would corrupt a 77-key product that carries an
 * 8 KB nested object.
 *
 * Usage:
 *   node apply-product-delta.mjs --target <product.json> --delta <delta.json> [--check|--write]
 *
 * `--check` is the default. It never writes and reports whether the target
 * already matches the delta, so a caller can preview before mutating.
 *
 * Exit codes:
 *   0  the target already equals the desired result (both modes)
 *   1  an update is needed (`--check` only)
 *   2  an error: bad arguments, missing input, unparseable JSON, bad delta shape
 */

import { readFileSync, writeFileSync } from 'node:fs';

const EXIT_UP_TO_DATE = 0;
const EXIT_NEEDS_UPDATE = 1;
const EXIT_ERROR = 2;

const USAGE = [
  'Usage: node apply-product-delta.mjs --target <product.json> --delta <delta.json> [--check|--write]',
  '',
  '  --target <path>   the product.json to inspect or rewrite (required)',
  '  --delta <path>    the product delta to apply (required)',
  '  --check           report whether an update is needed, never write (default)',
  '  --write           apply the delta and write the target',
].join('\n');

/**
 * Minimal argument parser. Unknown flags and repeated flags are rejected rather
 * than ignored, so a typo cannot silently turn a preview into a write.
 */
function parseArgs(argv) {
  const parsed = { mode: 'check', target: null, delta: null };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--check' || arg === '--write') {
      const mode = arg.slice(2);
      if (parsed.mode !== 'check' && parsed.mode !== mode) {
        throw new Error(`conflicting mode flags: --${parsed.mode} and ${arg}`);
      }
      parsed.mode = mode;
      continue;
    }

    if (arg === '--target' || arg === '--delta') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      const key = arg.slice(2);
      if (parsed[key] !== null) {
        throw new Error(`${arg} was given more than once`);
      }
      parsed[key] = value;
      index += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      return { help: true };
    }

    throw new Error(`unrecognized argument: ${arg}`);
  }

  if (parsed.help) {
    return parsed;
  }
  if (!parsed.target) {
    throw new Error('--target is required');
  }
  if (!parsed.delta) {
    throw new Error('--delta is required');
  }
  return parsed;
}

function readJson(path, label) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`cannot read the ${label} at ${path}: ${error.message}`);
  }
  try {
    return { text, value: JSON.parse(text) };
  } catch (error) {
    throw new Error(`the ${label} at ${path} is not valid JSON: ${error.message}`);
  }
}

/**
 * The delta shape is validated explicitly: a silent mismatch here would produce
 * a half-applied product that still parses.
 */
function validateDelta(delta) {
  const problems = [];
  const isPlainObject = (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const isStringArray = (value) =>
    Array.isArray(value) && value.every((entry) => typeof entry === 'string');
  const isStringArrayMap = (value) =>
    isPlainObject(value) && Object.values(value).every(isStringArray);

  if (!isPlainObject(delta)) {
    throw new Error('the delta must be a JSON object');
  }
  if (delta.set !== undefined && !isPlainObject(delta.set)) {
    problems.push('"set" must be an object');
  }
  if (delta.unset !== undefined && !isStringArray(delta.unset)) {
    problems.push('"unset" must be an array of strings');
  }
  if (delta.unsetNested !== undefined && !isStringArrayMap(delta.unsetNested)) {
    problems.push('"unsetNested" must map object keys to arrays of strings');
  }
  if (delta.unsetArrayEntries !== undefined && !isStringArrayMap(delta.unsetArrayEntries)) {
    problems.push('"unsetArrayEntries" must map array keys to arrays of strings');
  }

  const known = new Set(['set', 'unset', 'unsetNested', 'unsetArrayEntries']);
  for (const key of Object.keys(delta)) {
    if (!known.has(key)) {
      throw new Error(`unknown delta section "${key}"; expected one of ${[...known].join(', ')}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`the delta is malformed: ${problems.join('; ')}`);
  }

  return {
    set: delta.set ?? {},
    unset: delta.unset ?? [],
    unsetNested: delta.unsetNested ?? {},
    unsetArrayEntries: delta.unsetArrayEntries ?? {},
  };
}

/**
 * Builds the desired product from the current one.
 *
 * Key order is preserved by walking the existing keys first and appending only
 * genuinely new `set` keys afterwards, so the change reads in place. Container
 * objects the delta prunes are rebuilt as copies: the input object is never
 * mutated, which is what lets the caller compare "desired" against "current"
 * structurally.
 *
 * `unsetNested` exists because removing a container key is not the same as
 * emptying it. VS Code reads some product objects as a shape, so a key that must
 * stay present can still have its individual entries removed.
 */
function buildDesiredProduct(current, delta) {
  const desired = {};

  for (const [key, value] of Object.entries(current)) {
    if (delta.unset.includes(key)) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(delta.set, key)) {
      desired[key] = delta.set[key];
      continue;
    }

    const nestedKeys = delta.unsetNested[key];
    if (nestedKeys && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const pruned = {};
      for (const [subKey, subValue] of Object.entries(value)) {
        if (!nestedKeys.includes(subKey)) {
          pruned[subKey] = subValue;
        }
      }
      desired[key] = pruned;
      continue;
    }

    const entries = delta.unsetArrayEntries[key];
    if (entries && Array.isArray(value)) {
      desired[key] = value.filter((entry) => !entries.includes(entry));
      continue;
    }

    desired[key] = value;
  }

  for (const [key, value] of Object.entries(delta.set)) {
    if (!Object.prototype.hasOwnProperty.call(desired, key)) {
      desired[key] = value;
    }
  }

  return desired;
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Reuses the target's indentation unit, its line ending, and whether it was
 * compact at all, so a rewrite of an unchanged file is a no-op and a rewrite of
 * a changed file keeps its top-level shape.
 *
 * It does not reproduce VS Code's mixed style, where objects inside arrays open
 * on the same line as the bracket. `JSON.stringify` always expands nested arrays
 * onto their own lines, so the written file is larger on disk than the original
 * even when few keys changed. That is accepted deliberately: the target is a
 * build artefact that is never reviewed as a diff, and the alternative - line
 * level surgery on the raw text - would be far more fragile than a re-serialize
 * for a file no human reads in review.
 */
function detectFormatting(text) {
  const lineEnding = text.includes('\r\n') ? '\r\n' : '\n';
  const compact = !text.includes('\n');
  const indentMatch = text.match(/\n([ \t]+)"/);
  return { lineEnding, compact, indent: indentMatch ? indentMatch[1] : '  ' };
}

function serialize(product, formatting, originalText) {
  const body = formatting.compact
    ? JSON.stringify(product)
    : JSON.stringify(product, null, formatting.indent);
  const withLineEnding = formatting.lineEnding === '\n'
    ? body
    : body.split('\n').join(formatting.lineEnding);
  const trailing = formatting.compact
    ? ''
    : originalText.endsWith(`${formatting.lineEnding}`)
      ? formatting.lineEnding
      : '';
  return withLineEnding + trailing;
}

function report(current, delta, desired) {
  const lines = [];

  for (const [key, value] of Object.entries(delta.set)) {
    const unchanged = Object.prototype.hasOwnProperty.call(current, key) && deepEqual(current[key], value);
    lines.push(`  set ${key}${unchanged ? ' (already current)' : ''}`);
  }

  for (const key of delta.unset) {
    lines.push(`  unset ${key} (${Object.prototype.hasOwnProperty.call(current, key) ? 'removed' : 'already absent'})`);
  }

  // A container the delta prunes but which is absent or of the wrong type is
  // drift against upstream, not a silent no-op: report it so a renamed key does
  // not read as a successful removal.
  for (const [key, subKeys] of Object.entries(delta.unsetNested)) {
    const container = current[key];
    if (container === null || typeof container !== 'object' || Array.isArray(container)) {
      lines.push(`  unsetNested ${key}: ! no such object in the target, 0 of ${subKeys.length} entries removed`);
      continue;
    }
    const removed = subKeys.filter((subKey) => Object.prototype.hasOwnProperty.call(container, subKey)).length;
    lines.push(`  unsetNested ${key}: ${removed} of ${subKeys.length} entries removed`);
  }

  for (const [key, entriesToRemove] of Object.entries(delta.unsetArrayEntries)) {
    const container = current[key];
    if (!Array.isArray(container)) {
      lines.push(`  unsetArrayEntries ${key}: ! no such array in the target, 0 of ${entriesToRemove.length} entries removed`);
      continue;
    }
    const removed = entriesToRemove.filter((entry) => container.includes(entry)).length;
    lines.push(`  unsetArrayEntries ${key}: ${removed} of ${entriesToRemove.length} entries removed`);
  }

  lines.push(`  verdict: ${deepEqual(desired, current) ? 'already current' : 'needs update'}`);
  return lines;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT_UP_TO_DATE;
  }

  const target = readJson(args.target, 'target product');
  const deltaFile = readJson(args.delta, 'delta');
  const delta = validateDelta(deltaFile.value);

  const desired = buildDesiredProduct(target.value, delta);
  const upToDate = deepEqual(desired, target.value);

  process.stdout.write(`target: ${args.target}\n`);
  process.stdout.write(`delta:  ${args.delta}\n`);
  for (const line of report(target.value, delta, desired)) {
    process.stdout.write(`${line}\n`);
  }

  if (args.mode === 'check') {
    return upToDate ? EXIT_UP_TO_DATE : EXIT_NEEDS_UPDATE;
  }

  if (upToDate) {
    process.stdout.write('  write skipped: the target already matches the delta\n');
    return EXIT_UP_TO_DATE;
  }

  const formatting = detectFormatting(target.text);
  const serialized = serialize(desired, formatting, target.text);
  writeFileSync(args.target, serialized, 'utf8');

  // Re-read rather than trusting the write: a truncated or mis-encoded file
  // would otherwise only surface when the editor fails to start.
  const verify = readJson(args.target, 'written product');
  if (!deepEqual(verify.value, desired)) {
    throw new Error(`the written product at ${args.target} does not match the intended result`);
  }

  process.stdout.write(`  wrote ${args.target} (${serialized.length} bytes)\n`);
  return EXIT_UP_TO_DATE;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = EXIT_ERROR;
}
