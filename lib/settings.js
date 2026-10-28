/**
 * Where do received files land, and how does the user change it without
 * editing a profile?
 *
 * The obvious answer — write the new path into the profile patch — is the wrong
 * one. That file has more than one writer (the loader rewrites managed blocks
 * on reload), and a plugin that edits it behind the loader's back will either
 * lose the edit or fight a rewrite. So the override lives in its own tiny file
 * in the user's home, and the resolution order is:
 *
 *   runtime override  >  config (profile)  >  default
 *
 * The file is read per request with a one-second cache, so `setdir` takes effect
 * on the very next photo instead of on the next restart.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/*
 * The override path is read from the environment on every access rather than
 * frozen at import time. Two reasons: tests must be able to point it at a temp
 * file instead of editing the user's real one, and a test that forgets must
 * still not be able to delete a real folder choice.
 */
export function settingsPath() {
  const forced = process.env.DSH_PHONE_DROP_SETTINGS;
  return typeof forced === 'string' && forced.trim() !== '' ? forced.trim() : join(homedir(), '.dsh-phone-drop.json');
}

const CACHE_MS = 1000;

let cached = { at: 0, value: undefined, file: '' };

/** Expand `~` and turn a relative path into an absolute one. */
export function expandPath(input) {
  const raw = String(input ?? '').trim();
  if (raw === '') return '';
  if (raw === '~') return homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(homedir(), raw.slice(2));
  return isAbsolute(raw) ? raw : resolve(raw);
}

/**
 * The override file's `dir`, or `undefined` when there is none to trust.
 *
 * A malformed file is treated as absent rather than fatal: a corrupt settings
 * file must never stop photos from landing somewhere.
 */
export function readOverride() {
  const now = Date.now();
  const file = settingsPath();
  if (cached.file === file && now - cached.at < CACHE_MS) return cached.value;

  let value;
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      const dir = expandPath(parsed?.dir);
      if (dir !== '') value = dir;
    }
  } catch {
    value = undefined;
  }
  cached = { at: now, value, file };
  return value;
}

/**
 * Persist a new target directory.
 *
 * @param {string} dir absolute path, `~` allowed
 * @returns {string} the normalized absolute path that was written
 */
export function writeOverride(dir) {
  const target = expandPath(dir);
  if (target === '') throw new Error('目录不能为空');
  mkdirSync(target, { recursive: true });
  if (!statSync(target).isDirectory()) throw new Error(`不是文件夹：${target}`);
  writeFileSync(settingsPath(), `${JSON.stringify({ dir: target }, null, 2)}\n`, 'utf8');
  cached = { at: 0, value: undefined, file: '' };
  return target;
}

/** Drop the override so the configured directory applies again. */
export function clearOverride() {
  rmSync(settingsPath(), { force: true });
  cached = { at: 0, value: undefined, file: '' };
}

/**
 * Resolve the directory a photo should land in right now.
 *
 * @param {string} configured the value from the profile, possibly empty
 * @param {string} fallback the built-in default
 * @returns {string}
 */
export function currentDir(configured, fallback) {
  const override = readOverride();
  if (override !== undefined) return override;
  const fromConfig = expandPath(configured);
  return fromConfig !== '' ? fromConfig : fallback;
}

/** Where the override file lives — shown in the UI so the user can find it. */
export const SETTINGS_FILE = settingsPath();
