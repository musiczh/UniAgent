import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('automation backend confines paths and applies weekday-only schedules', async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'ua-automation-hardening-'))
  const previousHome = process.env.HOME
  process.env.HOME = sandbox
  try {
    const { deleteAutomation, getAutomationDetail, setAutomationStatus, updateAutomation } = await import('../src/main/scanners.ts')

    await t.test('allows an ordinary file under a configured root', async () => {
      const taskDir = join(sandbox, '.codex', 'automations', 'ordinary')
      const taskPath = join(taskDir, 'automation.toml')
      await mkdir(taskDir, { recursive: true })
      await writeFile(taskPath, 'id = "ordinary"\nstatus = "PAUSED"\n')
      assert.equal(await setAutomationStatus(taskPath, 'active'), true)
      assert.match(await readFile(taskPath, 'utf8'), /^status = "ACTIVE"$/m)
    })

    await t.test('rejects root-external files and symlinks that escape a root', async () => {
      const outsidePath = join(sandbox, 'outside.toml')
      const outsideOriginal = 'status = "PAUSED"\n'
      await writeFile(outsidePath, outsideOriginal)
      const linkedDir = join(sandbox, '.codex', 'automations', 'linked')
      const linkedPath = join(linkedDir, 'automation.toml')
      await mkdir(linkedDir, { recursive: true })
      await symlink(outsidePath, linkedPath)
      const outsideLink = join(sandbox, 'outside-link.toml')
      const ordinaryPath = join(sandbox, '.codex', 'automations', 'ordinary', 'automation.toml')
      await symlink(ordinaryPath, outsideLink)

      const results = {
        outsideStatus: await setAutomationStatus(outsidePath, 'active'),
        outsideUpdate: await updateAutomation(outsidePath, { name: 'Blocked' }),
        outsideDetail: await getAutomationDetail(outsidePath),
        outsideDelete: await deleteAutomation(outsidePath),
        linkedStatus: await setAutomationStatus(linkedPath, 'active'),
        linkedUpdate: await updateAutomation(linkedPath, { name: 'Blocked' }),
        linkedDetail: await getAutomationDetail(linkedPath),
        linkedDelete: await deleteAutomation(linkedPath),
        outsideLinkStatus: await setAutomationStatus(outsideLink, 'paused')
      }
      assert.deepEqual(results, {
        outsideStatus: false, outsideUpdate: false, outsideDetail: null, outsideDelete: false,
        linkedStatus: false, linkedUpdate: false, linkedDetail: null, linkedDelete: false,
        outsideLinkStatus: false
      })
      assert.equal(await readFile(outsidePath, 'utf8'), outsideOriginal)
      assert.match(await readFile(ordinaryPath, 'utf8'), /^status = "ACTIVE"$/m)
    })

    await t.test('rewrites five and six field cron day-of-week values', async () => {
      const taskDir = join(sandbox, '.codex', 'automations', 'daily')
      const taskPath = join(taskDir, 'automation.toml')
      await mkdir(taskDir, { recursive: true })
      await writeFile(taskPath, 'id = "daily"\ncron = "0 9 * * *"\nstatus = "PAUSED"\n')
      assert.equal(await updateAutomation(taskPath, { weekdayOnly: true }), true)
      assert.match(await readFile(taskPath, 'utf8'), /^cron = "0 9 \* \* 1-5"$/m)
      assert.equal((await getAutomationDetail(taskPath))?.weekdayOnly, true)
      assert.equal(await updateAutomation(taskPath, { weekdayOnly: false }), true)
      assert.match(await readFile(taskPath, 'utf8'), /^cron = "0 9 \* \* \*"$/m)

      const sixFieldDir = join(sandbox, '.trae', 'cli', 'automations', 'hourly')
      const sixFieldPath = join(sixFieldDir, 'automation.toml')
      await mkdir(sixFieldDir, { recursive: true })
      await writeFile(sixFieldPath, 'id = "hourly"\ncron = "0 15 10 * * *"\nstatus = "ACTIVE"\n')
      assert.equal(await updateAutomation(sixFieldPath, { weekdayOnly: true }), true)
      assert.match(await readFile(sixFieldPath, 'utf8'), /^cron = "0 15 10 \* \* 1-5"$/m)
    })

    await t.test('migrates cron-only tasks to an rrule key when saving normalized RRULE', async () => {
      const taskDir = join(sandbox, '.codex', 'automations', 'migrated')
      const taskPath = join(taskDir, 'automation.toml')
      const rrule = 'RRULE:FREQ=DAILY;BYHOUR=10;BYMINUTE=15'
      await mkdir(taskDir, { recursive: true })
      await writeFile(taskPath, 'id = "migrated"\ncron = "0 9 * * *"\ntimezone = "Asia/Shanghai"\n')

      assert.equal(await updateAutomation(taskPath, { schedule: rrule }), true)
      const saved = await readFile(taskPath, 'utf8')
      assert.match(saved, /^rrule = "RRULE:FREQ=DAILY;BYHOUR=10;BYMINUTE=15"$/m)
      assert.doesNotMatch(saved, /^cron\s*=/m)
      assert.match(saved, /^timezone = "Asia\/Shanghai"$/m)
      assert.equal((await getAutomationDetail(taskPath))?.schedule, rrule)

      const rawDir = join(sandbox, '.codex', 'automations', 'raw')
      const rawPath = join(rawDir, 'automation.toml')
      await mkdir(rawDir, { recursive: true })
      const rawOriginal = 'id = "raw"\ncron = "0 9 * * *"\n'
      await writeFile(rawPath, rawOriginal)
      assert.equal(await updateAutomation(rawPath, { schedule: 'raw text exactly' }), false)
      assert.equal(await readFile(rawPath, 'utf8'), rawOriginal)
    })

    await t.test('rejects an invalid cron atomically', async () => {
      const invalidDir = join(sandbox, '.codex', 'automations', 'invalid')
      const invalidPath = join(invalidDir, 'automation.toml')
      const invalidOriginal = 'id = "invalid"\nname = "Before"\ncron = "not-a-cron"\n'
      await mkdir(invalidDir, { recursive: true })
      await writeFile(invalidPath, invalidOriginal)
      assert.equal(await updateAutomation(invalidPath, { name: 'After', weekdayOnly: true }), false)
      assert.equal(await readFile(invalidPath, 'utf8'), invalidOriginal)
      assert.equal(await updateAutomation(invalidPath, { name: 'After', schedule: '0 0 24 * * *' }), false)
      assert.equal(await readFile(invalidPath, 'utf8'), invalidOriginal)
    })
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(sandbox, { recursive: true, force: true })
  }
})
