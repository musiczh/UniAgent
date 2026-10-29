import assert from 'node:assert/strict'
import {
  chmodSync, closeSync, constants as fsConstants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync,
  readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync
} from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  AtomicFsError, atomicRemoveIdentitySync, atomicRenameAnchoredSync, atomicRenameExclusiveSync,
  capabilityFsHelperPath, helperAvailable, platformSupported, processStartIdentitySync
} from '../src/main/capability-sync/atomicFs.ts'

const require = createRequire(import.meta.url)
const addonPath = capabilityFsHelperPath()
const addon = require(addonPath)
const testAddonPath = join(dirname(addonPath), 'ua-capability-fs-test.node')
const testAddon = existsSync(testAddonPath) ? require(testAddonPath) : undefined

function fixture(t) {
  return mkdtemp(join(tmpdir(), 'ua-atomic-fs-')).then((root) => {
    t.after(() => rm(root, { recursive: true, force: true }))
    return root
  })
}

function parentIdentity(path) {
  const info = lstatSync(path, { bigint: true })
  return { dev: info.dev, ino: info.ino, mode: Number(info.mode & 0o777n) }
}

function entryIdentity(path) {
  const info = lstatSync(path, { bigint: true })
  return { dev: info.dev, ino: info.ino }
}

function sourceIdentity(path) {
  const info = lstatSync(path, { bigint: true })
  const type = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : undefined
  assert.ok(type)
  return { dev: info.dev, ino: info.ino, type }
}

function assertAtomicError(code, applied = false) {
  return (error) => error instanceof AtomicFsError && error.code === code && error.message === code &&
    error.applied === applied
}

function assertAtomicRenameError(code, phase, disposition, applied = false) {
  return (error) => assertAtomicError(code, applied)(error) && error.phase === phase &&
    error.disposition === disposition
}

test('addon is available and successful rename uses the expected parent identity', async (t) => {
  const root = await fixture(t)
  writeFileSync(join(root, 'source'), 'source payload', { mode: 0o600 })
  assert.equal(platformSupported, true)
  assert.equal(helperAvailable(), true)
  assert.match(addonPath, /\.node$/)
  assert.equal(statSync(addonPath).mode & 0o111, 0)
  assert.deepEqual(Object.keys(addon).sort(), ['processStart', 'removeIdentity', 'renameAnchored', 'renameExclusive'])

  atomicRenameExclusiveSync(root, 'source', 'destination', parentIdentity(root), sourceIdentity(join(root, 'source')))

  assert.equal(existsSync(join(root, 'source')), false)
  assert.equal(readFileSync(join(root, 'destination'), 'utf8'), 'source payload')
})

test('anchored rename captures, verifies, syncs, and publishes the expected entry', async (t) => {
  const root = await fixture(t)
  writeFileSync(join(root, 'source'), 'anchored payload', { mode: 0o600 })

  const outcome = atomicRenameAnchoredSync(
    root, 'source', '.anchor-high-entropy-0123456789abcdef', 'destination',
    parentIdentity(root), sourceIdentity(join(root, 'source'))
  )

  assert.deepEqual(outcome, { phase: 'sync', disposition: 'published', applied: true })
  assert.equal(existsSync(join(root, 'source')), false)
  assert.equal(existsSync(join(root, '.anchor-high-entropy-0123456789abcdef')), false)
  assert.equal(readFileSync(join(root, 'destination'), 'utf8'), 'anchored payload')
})

test('anchored rename retains the verified anchor when the final target exists', async (t) => {
  const root = await fixture(t)
  const anchor = '.anchor-high-entropy-fedcba9876543210'
  writeFileSync(join(root, 'source'), 'source payload', { mode: 0o600 })
  writeFileSync(join(root, 'destination'), 'target payload', { mode: 0o600 })

  assert.throws(() => atomicRenameAnchoredSync(
    root, 'source', anchor, 'destination', parentIdentity(root), sourceIdentity(join(root, 'source'))
  ), assertAtomicRenameError('atomic_fs_destination_exists', 'anchor_to_target', 'anchor_retained'))

  assert.equal(existsSync(join(root, 'source')), false)
  assert.equal(readFileSync(join(root, anchor), 'utf8'), 'source payload')
  assert.equal(readFileSync(join(root, 'destination'), 'utf8'), 'target payload')
})

test('anchored rename preserves both entries when the caller-provided anchor exists', async (t) => {
  const root = await fixture(t)
  writeFileSync(join(root, 'source'), 'source payload', { mode: 0o600 })
  writeFileSync(join(root, '.occupied-anchor'), 'anchor payload', { mode: 0o600 })

  assert.throws(() => atomicRenameAnchoredSync(
    root, 'source', '.occupied-anchor', 'destination',
    parentIdentity(root), sourceIdentity(join(root, 'source'))
  ), assertAtomicRenameError('atomic_fs_anchor_exists', 'source_to_anchor', 'source_unchanged'))

  assert.equal(readFileSync(join(root, 'source'), 'utf8'), 'source payload')
  assert.equal(readFileSync(join(root, '.occupied-anchor'), 'utf8'), 'anchor payload')
  assert.equal(existsSync(join(root, 'destination')), false)
})

test('anchored rename rejects invalid or repeated names before mutation', async (t) => {
  const root = await fixture(t)
  writeFileSync(join(root, 'source'), 'payload', { mode: 0o600 })
  const parent = parentIdentity(root)
  const source = sourceIdentity(join(root, 'source'))

  for (const names of [
    ['source', 'source', 'destination'],
    ['source', 'destination', 'source'],
    ['source', 'destination', 'destination'],
    ['source', '../anchor', 'destination']
  ]) {
    assert.throws(() => atomicRenameAnchoredSync(root, ...names, parent, source),
      assertAtomicError('atomic_fs_invalid_name'))
  }
  assert.equal(readFileSync(join(root, 'source'), 'utf8'), 'payload')
  assert.equal(existsSync(join(root, 'destination')), false)
})

test('exclusive rename preserves source and destination files, directories, and symlinks', async (t) => {
  for (const kind of ['file', 'directory', 'symlink']) {
    await t.test(kind, async (t) => {
      const root = await fixture(t)
      const source = join(root, 'source')
      const destination = join(root, 'destination')
      if (kind === 'file') {
        writeFileSync(source, 'source file', { mode: 0o600 })
        writeFileSync(destination, 'destination file', { mode: 0o600 })
      } else if (kind === 'directory') {
        mkdirSync(source, { mode: 0o700 })
        mkdirSync(destination, { mode: 0o700 })
        writeFileSync(join(source, 'value'), 'source directory', { mode: 0o600 })
        writeFileSync(join(destination, 'value'), 'destination directory', { mode: 0o600 })
      } else {
        symlinkSync('source-target', source)
        symlinkSync('destination-target', destination)
      }

      assert.throws(
        () => atomicRenameExclusiveSync(
          root, 'source', 'destination', parentIdentity(root), sourceIdentity(source)
        ),
        assertAtomicError('atomic_fs_destination_exists')
      )

      if (kind === 'file') {
        assert.equal(readFileSync(source, 'utf8'), 'source file')
        assert.equal(readFileSync(destination, 'utf8'), 'destination file')
      } else if (kind === 'directory') {
        assert.equal(readFileSync(join(source, 'value'), 'utf8'), 'source directory')
        assert.equal(readFileSync(join(destination, 'value'), 'utf8'), 'destination directory')
      } else {
        assert.equal(readlinkSync(source), 'source-target')
        assert.equal(readlinkSync(destination), 'destination-target')
      }
    })
  }
})

test('native rename remains pinned when the parent pathname is replaced', async (t) => {
  const root = await fixture(t)
  const parent = join(root, 'parent')
  const pinned = join(root, 'pinned')
  const outside = join(root, 'outside')
  mkdirSync(parent, { mode: 0o700 })
  mkdirSync(outside, { mode: 0o700 })
  writeFileSync(join(parent, 'source'), 'pinned payload', { mode: 0o600 })

  const fd = openSync(parent, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
  const expectedSource = sourceIdentity(join(parent, 'source'))
  try {
    renameSync(parent, pinned)
    symlinkSync(outside, parent)
    addon.renameExclusive(
      fd, 'source', 'destination', String(expectedSource.dev), String(expectedSource.ino), expectedSource.type
    )
  } finally {
    closeSync(fd)
  }

  assert.equal(readFileSync(join(pinned, 'destination'), 'utf8'), 'pinned payload')
  assert.equal(existsSync(join(outside, 'destination')), false)
})

test('wrapper rejects a swapped parent pathname before native invocation', async (t) => {
  const root = await fixture(t)
  const parent = join(root, 'parent')
  const moved = join(root, 'moved')
  mkdirSync(parent, { mode: 0o700 })
  const expected = parentIdentity(parent)
  writeFileSync(join(parent, 'source'), 'original', { mode: 0o600 })
  const expectedSource = sourceIdentity(join(parent, 'source'))
  renameSync(parent, moved)
  mkdirSync(parent, { mode: 0o700 })
  writeFileSync(join(parent, 'source'), 'replacement', { mode: 0o600 })

  assert.throws(() => atomicRenameExclusiveSync(parent, 'source', 'destination', expected, expectedSource),
    assertAtomicError('atomic_fs_parent_changed'))
  assert.equal(readFileSync(join(parent, 'source'), 'utf8'), 'replacement')
  assert.equal(readFileSync(join(moved, 'source'), 'utf8'), 'original')
  assert.equal(existsSync(join(parent, 'destination')), false)
  assert.equal(existsSync(join(moved, 'destination')), false)
})

test('wrapper compares parent permission bits as part of the expected identity', async (t) => {
  const root = await fixture(t)
  writeFileSync(join(root, 'source'), 'unchanged', { mode: 0o600 })
  const expected = parentIdentity(root)
  const expectedSource = sourceIdentity(join(root, 'source'))
  chmodSync(root, 0o755)

  assert.throws(() => atomicRenameExclusiveSync(root, 'source', 'destination', expected, expectedSource),
    assertAtomicError('atomic_fs_parent_changed'))
  assert.equal(readFileSync(join(root, 'source'), 'utf8'), 'unchanged')
  assert.equal(existsSync(join(root, 'destination')), false)
})

test('wrapper rejects a same-name source replacement before rename', async (t) => {
  const root = await fixture(t)
  const source = join(root, 'source')
  const original = join(root, 'original')
  writeFileSync(source, 'sealed source', { mode: 0o600 })
  const expectedSource = sourceIdentity(source)
  renameSync(source, original)
  writeFileSync(source, 'replacement source', { mode: 0o600 })

  assert.throws(
    () => atomicRenameExclusiveSync(
      root, 'source', 'destination', parentIdentity(root), expectedSource
    ),
    assertAtomicError('atomic_fs_identity_mismatch')
  )
  assert.equal(readFileSync(original, 'utf8'), 'sealed source')
  assert.equal(readFileSync(source, 'utf8'), 'replacement source')
  assert.equal(existsSync(join(root, 'destination')), false)
})

test('native rename validates source identity and type on the opened parent fd', async (t) => {
  const root = await fixture(t)
  const source = join(root, 'source')
  writeFileSync(source, 'payload', { mode: 0o600 })
  const expectedSource = sourceIdentity(source)
  const parentFd = openSync(root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
  try {
    assert.throws(
      () => addon.renameExclusive(
        parentFd, 'source', 'destination', String(expectedSource.dev), String(expectedSource.ino), 'directory'
      ),
      (error) => error?.code === 'identity_mismatch'
    )
  } finally {
    closeSync(parentFd)
  }
  assert.equal(readFileSync(source, 'utf8'), 'payload')
  assert.equal(existsSync(join(root, 'destination')), false)
})

test('anchored rename detects the preflight-to-rename race and retains the wrong inode outside target',
  { skip: !testAddon }, async (t) => {
    const root = await fixture(t)
    const source = join(root, 'source')
    const displaced = join(root, 'sealed-source')
    const anchor = '.race-anchor-0123456789abcdef'
    writeFileSync(source, 'sealed payload', { mode: 0o600 })
    const expected = sourceIdentity(source)

    testAddon.testSetBeforeFirstRenameHook(() => {
      renameSync(source, displaced)
      writeFileSync(source, 'replacement payload', { mode: 0o600 })
    })
    const parentFd = openSync(root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
    try {
      assert.throws(() => testAddon.renameAnchored(
        parentFd, 'source', anchor, 'destination', String(expected.dev), String(expected.ino), expected.type
      ), (error) => error?.code === 'identity_mismatch' && error?.phase === 'verify_anchor' &&
        error?.disposition === 'anchor_retained' && error?.applied === false)
    } finally {
      closeSync(parentFd)
    }

    assert.equal(readFileSync(displaced, 'utf8'), 'sealed payload')
    assert.equal(existsSync(source), false)
    assert.equal(readFileSync(join(root, anchor), 'utf8'), 'replacement payload')
    assert.equal(existsSync(join(root, 'destination')), false)
  })

test('wrapper preserves anchored race disposition and never publishes the wrong inode',
  { skip: !testAddon }, async (t) => {
    const root = await fixture(t)
    const source = join(root, 'source')
    const displaced = join(root, 'sealed-source')
    const anchor = '.wrapper-race-anchor-0123456789'
    writeFileSync(source, 'sealed payload', { mode: 0o600 })
    const expected = sourceIdentity(source)
    const backupAddonPath = `${addonPath}.${process.pid}.production-anchor-race`
    const atomicFsUrl = new URL('../src/main/capability-sync/atomicFs.ts', import.meta.url).href
    renameSync(addonPath, backupAddonPath)
    try {
      copyFileSync(testAddonPath, addonPath)
      const script = `
        import { lstatSync, renameSync, writeFileSync } from 'node:fs'
        import { createRequire } from 'node:module'
        import { AtomicFsError, atomicRenameAnchoredSync, capabilityFsHelperPath }
          from ${JSON.stringify(atomicFsUrl)}
        const require = createRequire(import.meta.url)
        const native = require(capabilityFsHelperPath())
        native.testSetBeforeFirstRenameHook(() => {
          renameSync(${JSON.stringify(source)}, ${JSON.stringify(displaced)})
          writeFileSync(${JSON.stringify(source)}, 'replacement payload', { mode: 0o600 })
        })
        const parent = lstatSync(${JSON.stringify(root)}, { bigint: true })
        try {
          atomicRenameAnchoredSync(
            ${JSON.stringify(root)}, 'source', ${JSON.stringify(anchor)}, 'destination',
            { dev: parent.dev, ino: parent.ino, mode: Number(parent.mode & 0o777n) },
            { dev: ${JSON.stringify(String(expected.dev))}, ino: ${JSON.stringify(String(expected.ino))}, type: 'file' }
          )
          process.exitCode = 2
        } catch (error) {
          if (!(error instanceof AtomicFsError)) process.exitCode = 3
          else process.stdout.write(JSON.stringify({
            code: error.code, applied: error.applied, phase: error.phase, disposition: error.disposition
          }))
        }
      `
      const child = spawnSync(process.execPath, [
        '--experimental-strip-types', '--input-type=module', '--eval', script
      ], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 })
      assert.equal(child.status, 0, child.stderr || child.stdout)
      assert.deepEqual(JSON.parse(child.stdout), {
        code: 'atomic_fs_identity_mismatch', applied: false,
        phase: 'verify_anchor', disposition: 'anchor_retained'
      })
    } finally {
      rmSync(addonPath, { force: true })
      renameSync(backupAddonPath, addonPath)
    }
    assert.equal(readFileSync(displaced, 'utf8'), 'sealed payload')
    assert.equal(existsSync(source), false)
    assert.equal(readFileSync(join(root, anchor), 'utf8'), 'replacement payload')
    assert.equal(existsSync(join(root, 'destination')), false)
  })

test('anchored rename does not move a verified anchor when the target appears before publish',
  { skip: !testAddon }, async (t) => {
    const root = await fixture(t)
    writeFileSync(join(root, 'source'), 'expected payload', { mode: 0o600 })
    const expected = sourceIdentity(join(root, 'source'))

    testAddon.testSetBeforeSecondRenameHook(() => {
      writeFileSync(join(root, 'destination'), 'hostile replacement', { mode: 0o600 })
    })
    const parentFd = openSync(root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
    try {
      assert.throws(() => testAddon.renameAnchored(
        parentFd, 'source', '.target-race-anchor-0123456789', 'destination',
        String(expected.dev), String(expected.ino), expected.type
      ), (error) => error?.code === 'destination_exists' && error?.phase === 'anchor_to_target' &&
        error?.disposition === 'anchor_retained' && error?.applied === false)
    } finally {
      closeSync(parentFd)
    }

    assert.equal(readFileSync(join(root, '.target-race-anchor-0123456789'), 'utf8'), 'expected payload')
    assert.equal(readFileSync(join(root, 'destination'), 'utf8'), 'hostile replacement')
  })

test('anchored rename post-verifies and preserves evidence when the anchor is swapped before publish',
  { skip: !testAddon }, async (t) => {
    const root = await fixture(t)
    const anchor = join(root, '.swapped-anchor-0123456789abcdef')
    const displaced = join(root, 'verified-anchor-displaced')
    const target = join(root, 'destination')
    writeFileSync(join(root, 'source'), 'expected payload', { mode: 0o600 })
    const expected = sourceIdentity(join(root, 'source'))

    testAddon.testSetBeforeSecondRenameHook(() => {
      renameSync(anchor, displaced)
      writeFileSync(anchor, 'hostile replacement', { mode: 0o600 })
    })
    const parentFd = openSync(root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
    try {
      assert.throws(() => testAddon.renameAnchored(
        parentFd, 'source', '.swapped-anchor-0123456789abcdef', 'destination',
        String(expected.dev), String(expected.ino), expected.type
      ), (error) => error?.code === 'identity_mismatch' && error?.phase === 'verify_target' &&
        error?.disposition === 'unknown' && error?.applied === false)
    } finally {
      closeSync(parentFd)
    }

    assert.equal(readFileSync(displaced, 'utf8'), 'expected payload')
    assert.equal(readFileSync(target, 'utf8'), 'hostile replacement')
    assert.equal(existsSync(anchor), false)
  })

test('wrapper rejects non-basename inputs and a missing source without filesystem changes', async (t) => {
  const root = await fixture(t)
  writeFileSync(join(root, 'source'), 'unchanged', { mode: 0o600 })
  const expectedSource = sourceIdentity(join(root, 'source'))
  const invalidNames = ['', '.', '..', '/absolute', '../escape', 'nested/name', 'line\nbreak', 'x'.repeat(256)]

  for (const name of invalidNames) {
    assert.throws(() => atomicRenameExclusiveSync(root, 'source', name, parentIdentity(root), expectedSource),
      assertAtomicError('atomic_fs_invalid_name'))
  }
  assert.throws(() => atomicRenameExclusiveSync(root, 'source', 'source', parentIdentity(root), expectedSource),
    assertAtomicError('atomic_fs_invalid_name'))
  assert.throws(() => atomicRenameExclusiveSync(root, 'missing', 'destination', parentIdentity(root), expectedSource),
    assertAtomicError('atomic_fs_source_not_found'))
  assert.equal(readFileSync(join(root, 'source'), 'utf8'), 'unchanged')
  assert.equal(existsSync(join(root, 'destination')), false)
  assert.equal(existsSync(join(root, 'escape')), false)
})

test('identity removal recursively deletes owned entries without following symlinks', async (t) => {
  const root = await fixture(t)
  const owned = join(root, 'owned')
  const nested = join(owned, 'nested')
  const outside = join(root, 'outside')
  mkdirSync(owned, { mode: 0o700 })
  mkdirSync(nested, { mode: 0o700 })
  mkdirSync(outside, { mode: 0o700 })
  writeFileSync(join(owned, 'file'), 'owned file', { mode: 0o600 })
  writeFileSync(join(nested, 'file'), 'nested file', { mode: 0o600 })
  writeFileSync(join(outside, 'sentinel'), 'outside', { mode: 0o600 })
  symlinkSync(outside, join(owned, 'outside-directory-link'))
  symlinkSync(join(outside, 'sentinel'), join(nested, 'outside-file-link'))
  const expectedEntry = entryIdentity(owned)

  atomicRemoveIdentitySync(root, 'owned', parentIdentity(root), expectedEntry)

  assert.equal(existsSync(owned), false)
  assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'outside')
})

test('recursive removal preserves a descendant replaced after the complete identity snapshot',
  { skip: !testAddon }, async (t) => {
    const root = await fixture(t)
    const target = join(root, 'target')
    const nested = join(target, 'nested')
    const displaced = join(root, 'displaced')
    mkdirSync(target, { mode: 0o700 })
    mkdirSync(nested, { mode: 0o700 })
    writeFileSync(join(nested, 'leaf'), 'original leaf', { mode: 0o600 })
    const expected = entryIdentity(target)

    testAddon.testSetBeforeRemoveHook(() => {
      renameSync(join(nested, 'leaf'), displaced)
      writeFileSync(join(nested, 'leaf'), 'replacement leaf', { mode: 0o600 })
    })

    const parentFd = openSync(root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
    try {
      assert.throws(
        () => testAddon.removeIdentity(parentFd, 'target', String(expected.dev), String(expected.ino)),
        (error) => error?.code === 'identity_mismatch'
      )
    } finally {
      closeSync(parentFd)
    }
    assert.equal(readFileSync(displaced, 'utf8'), 'original leaf')
    assert.equal(readFileSync(join(nested, 'leaf'), 'utf8'), 'replacement leaf')
  })

test('recursive removal preserves a child added after the complete identity snapshot',
  { skip: !testAddon }, async (t) => {
    const root = await fixture(t)
    const target = join(root, 'target')
    mkdirSync(target, { mode: 0o700 })
    writeFileSync(join(target, 'owned'), 'owned', { mode: 0o600 })
    const expected = entryIdentity(target)

    testAddon.testSetBeforeRemoveHook(() => {
      writeFileSync(join(target, 'replacement'), 'new child', { mode: 0o600 })
    })

    const parentFd = openSync(root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
    try {
      assert.throws(
        () => testAddon.removeIdentity(parentFd, 'target', String(expected.dev), String(expected.ino)),
        (error) => error?.code === 'identity_mismatch'
      )
    } finally {
      closeSync(parentFd)
    }
    assert.equal(readFileSync(join(target, 'owned'), 'utf8'), 'owned')
    assert.equal(readFileSync(join(target, 'replacement'), 'utf8'), 'new child')
  })

test('sync failure after exclusive rename reports that the mutation was applied',
  { skip: !testAddon }, async (t) => {
    const root = await fixture(t)
    writeFileSync(join(root, 'source'), 'payload', { mode: 0o600 })
    testAddon.testFailNextFsync(5, 1)
    const parentFd = openSync(root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
    try {
      const expectedSource = sourceIdentity(join(root, 'source'))
      assert.throws(() => testAddon.renameExclusive(
        parentFd, 'source', 'destination', String(expectedSource.dev), String(expectedSource.ino), expectedSource.type
      ),
        (error) => error?.code === 'sync_failed')
    } finally {
      closeSync(parentFd)
    }
    assert.equal(existsSync(join(root, 'source')), false)
    assert.equal(readFileSync(join(root, 'destination'), 'utf8'), 'payload')

  })

test('wrapper preserves sync failure codes and marks completed namespace mutations as applied',
  { skip: !testAddon }, async (t) => {
    const root = await fixture(t)
    writeFileSync(join(root, 'source'), 'payload', { mode: 0o600 })
    writeFileSync(join(root, 'remove-me'), 'remove payload', { mode: 0o600 })
    const backupAddonPath = `${addonPath}.${process.pid}.production`
    const atomicFsUrl = new URL('../src/main/capability-sync/atomicFs.ts', import.meta.url).href
    renameSync(addonPath, backupAddonPath)
    try {
      copyFileSync(testAddonPath, addonPath)
      const script = `
        import { lstatSync } from 'node:fs'
        import { createRequire } from 'node:module'
        import {
          AtomicFsError, atomicRemoveIdentitySync, atomicRenameExclusiveSync, capabilityFsHelperPath
        } from ${JSON.stringify(atomicFsUrl)}
        const require = createRequire(import.meta.url)
        const root = ${JSON.stringify(root)}
        const info = lstatSync(root, { bigint: true })
        const source = lstatSync(root + '/source', { bigint: true })
        const native = require(capabilityFsHelperPath())
        const outcomes = []
        native.testFailNextFsync(5, 1)
        try {
          atomicRenameExclusiveSync(root, 'source', 'destination', {
            dev: info.dev, ino: info.ino, mode: Number(info.mode & 0o777n)
          }, { dev: source.dev, ino: source.ino, type: 'file' })
          process.exitCode = 2
        } catch (error) {
          if (!(error instanceof AtomicFsError)) process.exitCode = 3
          else outcomes.push({
            code: error.code, message: error.message, applied: error.applied
          })
        }
        const removable = lstatSync(root + '/remove-me', { bigint: true })
        native.testFailNextFsync(5, 1)
        try {
          atomicRemoveIdentitySync(root, 'remove-me', {
            dev: info.dev, ino: info.ino, mode: Number(info.mode & 0o777n)
          }, { dev: removable.dev, ino: removable.ino })
          process.exitCode = 4
        } catch (error) {
          if (!(error instanceof AtomicFsError)) process.exitCode = 5
          else outcomes.push({
            code: error.code, message: error.message, applied: error.applied
          })
        }
        process.stdout.write(JSON.stringify(outcomes))
      `
      const child = spawnSync(process.execPath, [
        '--experimental-strip-types', '--input-type=module', '--eval', script
      ], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 })
      assert.equal(child.status, 0, child.stderr || child.stdout)
      assert.deepEqual(JSON.parse(child.stdout), [
        { code: 'atomic_fs_sync_failed', message: 'atomic_fs_sync_failed', applied: true },
        { code: 'atomic_fs_sync_failed', message: 'atomic_fs_sync_failed', applied: true }
      ])
    } finally {
      rmSync(addonPath, { force: true })
      renameSync(backupAddonPath, addonPath)
    }
    assert.equal(existsSync(join(root, 'source')), false)
    assert.equal(readFileSync(join(root, 'destination'), 'utf8'), 'payload')
    assert.equal(existsSync(join(root, 'remove-me')), false)
  })

test('AtomicFsError defaults to not applied before a filesystem mutation', () => {
  assert.equal(new AtomicFsError('atomic_fs_operation_failed').applied, false)
  assert.equal(new AtomicFsError('atomic_fs_sync_failed', true).applied, true)
})

test('anchored rename sync failures identify whether the anchor is retained or target is published',
  { skip: !testAddon }, async (t) => {
    for (const [name, successfulFsyncs, disposition, applied, expectedLocation] of [
      ['anchor sync', 0, 'anchor_retained', false, '.anchor-sync-failure'],
      ['target sync', 1, 'published', true, 'destination']
    ]) {
      await t.test(name, async (t) => {
        const root = await fixture(t)
        const anchor = '.anchor-sync-failure'
        writeFileSync(join(root, 'source'), 'payload', { mode: 0o600 })
        const expected = sourceIdentity(join(root, 'source'))
        testAddon.testFailFsyncAfter(5, successfulFsyncs)
        const parentFd = openSync(root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
        try {
          assert.throws(() => testAddon.renameAnchored(
            parentFd, 'source', anchor, 'destination', String(expected.dev), String(expected.ino), expected.type
          ), (error) => error?.code === 'sync_failed' && error?.phase === 'sync' &&
            error?.disposition === disposition && error?.applied === applied)
        } finally {
          closeSync(parentFd)
        }
        assert.equal(readFileSync(join(root, expectedLocation), 'utf8'), 'payload')
        assert.equal(existsSync(join(root, expectedLocation === anchor ? 'destination' : anchor)), false)
      })
    }
  })

test('wrapper preserves anchored sync phase, disposition, and applied semantics',
  { skip: !testAddon }, async (t) => {
    const root = await fixture(t)
    writeFileSync(join(root, 'source-anchor-sync'), 'anchor payload', { mode: 0o600 })
    writeFileSync(join(root, 'source-target-sync'), 'target payload', { mode: 0o600 })
    const backupAddonPath = `${addonPath}.${process.pid}.production-anchor-sync`
    const atomicFsUrl = new URL('../src/main/capability-sync/atomicFs.ts', import.meta.url).href
    renameSync(addonPath, backupAddonPath)
    try {
      copyFileSync(testAddonPath, addonPath)
      const script = `
        import { lstatSync } from 'node:fs'
        import { createRequire } from 'node:module'
        import { AtomicFsError, atomicRenameAnchoredSync, capabilityFsHelperPath }
          from ${JSON.stringify(atomicFsUrl)}
        const require = createRequire(import.meta.url)
        const root = ${JSON.stringify(root)}
        const native = require(capabilityFsHelperPath())
        const parent = lstatSync(root, { bigint: true })
        const parentIdentity = { dev: parent.dev, ino: parent.ino, mode: Number(parent.mode & 0o777n) }
        const outcomes = []
        for (const [sourceName, anchorName, targetName, successfulFsyncs] of [
          ['source-anchor-sync', '.wrapper-anchor-sync', 'target-after-anchor-sync', 0],
          ['source-target-sync', '.wrapper-target-sync', 'target-after-target-sync', 1]
        ]) {
          const source = lstatSync(root + '/' + sourceName, { bigint: true })
          native.testFailFsyncAfter(5, successfulFsyncs)
          try {
            atomicRenameAnchoredSync(root, sourceName, anchorName, targetName, parentIdentity,
              { dev: source.dev, ino: source.ino, type: 'file' })
            process.exitCode = 2
          } catch (error) {
            if (!(error instanceof AtomicFsError)) process.exitCode = 3
            else outcomes.push({
              code: error.code, applied: error.applied, phase: error.phase, disposition: error.disposition
            })
          }
        }
        process.stdout.write(JSON.stringify(outcomes))
      `
      const child = spawnSync(process.execPath, [
        '--experimental-strip-types', '--input-type=module', '--eval', script
      ], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 })
      assert.equal(child.status, 0, child.stderr || child.stdout)
      assert.deepEqual(JSON.parse(child.stdout), [
        { code: 'atomic_fs_sync_failed', applied: false, phase: 'sync', disposition: 'anchor_retained' },
        { code: 'atomic_fs_sync_failed', applied: true, phase: 'sync', disposition: 'published' }
      ])
    } finally {
      rmSync(addonPath, { force: true })
      renameSync(backupAddonPath, addonPath)
    }
    assert.equal(readFileSync(join(root, '.wrapper-anchor-sync'), 'utf8'), 'anchor payload')
    assert.equal(readFileSync(join(root, 'target-after-target-sync'), 'utf8'), 'target payload')
  })

test('identity removal refuses a replacement root and preserves both objects', async (t) => {
  const root = await fixture(t)
  const target = join(root, 'target')
  const original = join(root, 'original')
  mkdirSync(target, { mode: 0o700 })
  writeFileSync(join(target, 'sentinel'), 'original', { mode: 0o600 })
  const expectedEntry = entryIdentity(target)
  renameSync(target, original)
  mkdirSync(target, { mode: 0o700 })
  writeFileSync(join(target, 'sentinel'), 'replacement', { mode: 0o600 })

  assert.throws(() => atomicRemoveIdentitySync(root, 'target', parentIdentity(root), expectedEntry),
    assertAtomicError('atomic_fs_identity_mismatch'))
  assert.equal(readFileSync(join(original, 'sentinel'), 'utf8'), 'original')
  assert.equal(readFileSync(join(target, 'sentinel'), 'utf8'), 'replacement')
})

test('native identity removal remains pinned when the parent pathname is replaced', async (t) => {
  const root = await fixture(t)
  const parent = join(root, 'parent')
  const pinned = join(root, 'pinned')
  const outside = join(root, 'outside')
  mkdirSync(parent, { mode: 0o700 })
  mkdirSync(join(parent, 'target'), { mode: 0o700 })
  writeFileSync(join(parent, 'target', 'owned'), 'owned', { mode: 0o600 })
  mkdirSync(outside, { mode: 0o700 })
  mkdirSync(join(outside, 'target'), { mode: 0o700 })
  writeFileSync(join(outside, 'target', 'sentinel'), 'outside', { mode: 0o600 })
  const expectedEntry = entryIdentity(join(parent, 'target'))

  const fd = openSync(parent, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
  try {
    renameSync(parent, pinned)
    symlinkSync(outside, parent)
    addon.removeIdentity(fd, 'target', String(expectedEntry.dev), String(expectedEntry.ino))
  } finally {
    closeSync(fd)
  }

  assert.equal(existsSync(join(pinned, 'target')), false)
  assert.equal(readFileSync(join(outside, 'target', 'sentinel'), 'utf8'), 'outside')
})

test('identity removal reports missing entries and accepts file and symlink roots', async (t) => {
  const root = await fixture(t)
  assert.throws(() => atomicRemoveIdentitySync(root, 'missing', parentIdentity(root), { dev: 1, ino: 1 }),
    assertAtomicError('atomic_fs_source_not_found'))

  const file = join(root, 'file')
  writeFileSync(file, 'file', { mode: 0o600 })
  atomicRemoveIdentitySync(root, 'file', parentIdentity(root), entryIdentity(file))
  assert.equal(existsSync(file), false)

  const outside = join(root, 'outside')
  const link = join(root, 'link')
  writeFileSync(outside, 'outside', { mode: 0o600 })
  symlinkSync(outside, link)
  atomicRemoveIdentitySync(root, 'link', parentIdentity(root), entryIdentity(link))
  assert.equal(existsSync(link), false)
  assert.equal(readFileSync(outside, 'utf8'), 'outside')
})

test('process start identity is stable, normalized, bounded, and validates pid input', () => {
  const first = processStartIdentitySync(process.pid)
  const second = processStartIdentitySync(process.pid)
  assert.equal(first, second)
  assert.match(first, /^v1:[1-9]\d{0,19}:\d{6}$/)
  assert.ok(Buffer.byteLength(first) < 64)
  assert.equal(processStartIdentitySync(2_147_483_647), undefined)
  for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    assert.throws(() => processStartIdentitySync(invalid), assertAtomicError('atomic_fs_invalid_pid'))
  }
})

test('runtime uses a direct N-API bundle and contains no executable helper path', () => {
  const nativeSource = readFileSync(new URL('../native/capability-fs-addon.c', import.meta.url), 'utf8')
  const wrapperSource = readFileSync(new URL('../src/main/capability-sync/atomicFs.ts', import.meta.url), 'utf8')
  const buildSource = readFileSync(new URL('../scripts/build-capability-fs-addon.mjs', import.meta.url), 'utf8')
  const packageSource = readFileSync(new URL('../package.json', import.meta.url), 'utf8')

  assert.match(nativeSource, /NAPI_MODULE_INIT\(\)/)
  assert.match(nativeSource, /renameatx_np\([^;]+RENAME_EXCL\)/s)
  assert.match(nativeSource,
    /renameatx_np\(parent_fd, source_name\.bytes, parent_fd, anchor_name\.bytes, RENAME_EXCL\)/)
  assert.match(nativeSource, /fstatat\(parent_fd, anchor_name\.bytes, &anchored, AT_SYMLINK_NOFOLLOW\)/)
  assert.match(nativeSource,
    /renameatx_np\(parent_fd, anchor_name\.bytes, parent_fd, target_name\.bytes, RENAME_EXCL\)/)
  assert.match(nativeSource, /fstatat\(parent_fd, target_name\.bytes, &target, AT_SYMLINK_NOFOLLOW\)/)
  assert.doesNotMatch(nativeSource,
    /renameatx_np\(parent_fd, anchor_name\.bytes, parent_fd, source_name\.bytes/)
  assert.match(nativeSource, /proc_pidinfo\([^;]+PROC_PIDTBSDINFO/s)
  assert.match(nativeSource, /arc4random_buf\(/)
  assert.match(nativeSource, /renameatx_np\(parent_fd, name, parent_fd, quarantine, RENAME_EXCL\)/)
  assert.match(nativeSource, /fstatat\(parent_fd, quarantine, &moved, AT_SYMLINK_NOFOLLOW\)/)
  assert.doesNotMatch(nativeSource, /unlinkat\(parent_fd, name/)
  assert.doesNotMatch(nativeSource, /RENAME_RESOLVE_BENEATH|\bmain\s*\(/)
  assert.doesNotMatch(wrapperSource, /node:child_process|child_process|\b(?:spawn|spawnSync|execFile|execFileSync|fork)\b/)
  assert.match(wrapperSource, /createRequire\(import\.meta\.url\)/)
  assert.match(buildSource, /-DNAPI_VERSION=8/)
  assert.match(buildSource, /'-bundle'/)
  assert.doesNotMatch(packageSource, /ua-capability-fs-helper/)
  assert.match(packageSource, /out\/native\/ua-capability-fs\.node/)
  const mainEntitlements = readFileSync(new URL('../native/entitlements.mac.plist', import.meta.url), 'utf8')
  const inheritedEntitlements = readFileSync(new URL('../native/entitlements.mac.inherit.plist', import.meta.url), 'utf8')
  assert.doesNotMatch(mainEntitlements, /disable-library-validation/)
  assert.doesNotMatch(inheritedEntitlements, /disable-library-validation/)
})
