const readline = require('node:readline')

const input = readline.createInterface({ input: process.stdin })
input.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ok: true } }) + '\n')
    return
  }
  if (message.method === 'echo') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'skills/changed', params: {} }) + '\n')
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.params }) + '\n')
  }
})
