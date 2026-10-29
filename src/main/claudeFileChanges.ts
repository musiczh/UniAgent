/** Convert Claude's recorded Edit/Write result into the existing file_change shape. */
export function claudeFileChange(name: unknown, input: any, result: any): { path: string; kind: 'add' | 'modify'; diff: string } | undefined {
  if (!['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(String(name)) || !result || typeof result !== 'object') return
  const path = result.filePath ?? input?.file_path ?? input?.notebook_path
  if (typeof path !== 'string' || !path) return
  if (result.type === 'create' && typeof result.content === 'string') {
    return { path, kind: 'add', diff: result.content }
  }
  const patches = result.structuredPatch
  if (!Array.isArray(patches) || !patches.length) return
  const hunks: string[] = []
  for (const patch of patches) {
    if (!Number.isSafeInteger(patch?.oldStart) || !Number.isSafeInteger(patch?.oldLines) ||
        !Number.isSafeInteger(patch?.newStart) || !Number.isSafeInteger(patch?.newLines) ||
        !Array.isArray(patch?.lines) || !patch.lines.every((line: unknown) => typeof line === 'string' && /^[ +\-]/.test(line))) return
    hunks.push(`@@ -${patch.oldStart},${patch.oldLines} +${patch.newStart},${patch.newLines} @@\n${patch.lines.join('\n')}`)
  }
  return { path, kind: 'modify', diff: hunks.join('\n') + '\n' }
}
