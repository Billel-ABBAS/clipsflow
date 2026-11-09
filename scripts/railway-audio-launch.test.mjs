import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const configPath = new URL('../deploy/railway/audio-services.json', import.meta.url);
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
const secret = 'TEST_ONLY_NOT_A_REAL_CREDENTIAL_123456789';

function launch(name, overrides = {}) {
  const service = config.services?.[name];
  assert.ok(service?.startCommand, `missing launcher for ${name}`);
  const dir = mkdtempSync(join(tmpdir(), 'clipsflow-audio-gate-'));
  try {
    // Deliberately substitute only the provider executable. The shell guard is real.
    for (const binary of ['python', 'node']) {
      writeFileSync(join(dir, binary), '#!/bin/sh\nprintf "PROVIDER_STARTED:%s\\n" "$*"\n', { mode: 0o700 });
    }
    return spawnSync('/bin/sh', ['-c', service.startCommand], {
      env: { PATH: `${dir}:/usr/bin:/bin`, ...service.environment, ...overrides },
      encoding: 'utf8', timeout: 2_000,
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function blocked(result, expected) {
  assert.equal(result.status, 78);
  assert.ok(result.stderr.includes(expected));
  assert.ok(!result.stdout.includes('PROVIDER_STARTED'));
  assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
}

test('records only pinned private staging services without credentials', () => {
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.activation, 'staged-only');
  assert.equal(config.environmentId, '3b7161b7-f10c-4833-b008-e52ff1bfe169');
  for (const service of Object.values(config.services)) {
    assert.equal(service.publicDomain, false);
    assert.match(service.image, /^ghcr\.io\/[a-zA-Z0-9_./-]+:v?\d+\.\d+\.\d+$/);
    assert.equal(service.environment.CLIPS_AUDIO_ROLLOUT_APPROVED, 'false');
    assert.equal(service.modelDownloadApproved, false);
    assert.equal(service.environment.HF_HUB_OFFLINE, '1');
    assert.ok(!Object.hasOwn(service.environment, 'OMNIVOICE_API_KEY'));
  }
});
for (const name of ['voicestudio', 'soundbox']) {
  test(`${name} refuses its default unapproved configuration`, () => {
    blocked(launch(name), 'audio_rollout_not_approved');
  });
  test(`${name} requires exactly true, not a truthy string`, () => {
    blocked(launch(name, { CLIPS_AUDIO_ROLLOUT_APPROVED: 'yes' }), 'audio_rollout_not_approved');
  });
}
test('VoiceStudio refuses absent or short authentication keys after approval', () => {
  for (const key of ['', 'short']) {
    blocked(launch('voicestudio', {
      CLIPS_AUDIO_ROLLOUT_APPROVED: 'true', OMNIVOICE_API_KEY: key,
    }), 'voicestudio_api_key_required');
  }
});
test('VoiceStudio forwards the documented private command without leaking a key', () => {
  const result = launch('voicestudio', {
    CLIPS_AUDIO_ROLLOUT_APPROVED: 'true', OMNIVOICE_API_KEY: secret,
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /PROVIDER_STARTED:-m backend\.docker_entrypoint --host :: --port 3900/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
});
test('Soundbox refuses to start before the private access gate is explicitly acknowledged', () => {
  blocked(launch('soundbox', { CLIPS_AUDIO_ROLLOUT_APPROVED: 'true' }), 'soundbox_private_gate_required');
});
test('Soundbox forwards the versioned image entrypoint only after both approvals', () => {
  const result = launch('soundbox', {
    CLIPS_AUDIO_ROLLOUT_APPROVED: 'true', CLIPS_SOUNDBOX_PRIVATE_GATE_READY: 'true',
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /PROVIDER_STARTED:\/opt\/soundbox\/server\/dist\/cli\.js --host :: --port 17494/);
});
