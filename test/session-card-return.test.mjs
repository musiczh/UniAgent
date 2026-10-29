import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8')

assert.match(app, /onJumpToSession={handleCardSessionJump}/, 'card jumps keep their source session')
assert.match(app, /className="session-return-btn"/, 'jump targets expose the return button')
assert.ok(app.includes('function handleSelect(id: string): void {\n    setSessionReturnId(null)'), 'normal navigation clears card history')
