const LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'csharp',
  rb: 'ruby', php: 'php', dart: 'dart', scala: 'scala', groovy: 'groovy', lua: 'lua',
  json: 'json', md: 'markdown', css: 'css', html: 'html', htm: 'html',
  sh: 'shell', bash: 'shell', zsh: 'shell', yml: 'yaml', yaml: 'yaml',
  toml: 'toml', xml: 'xml', sql: 'sql', vue: 'vue', svelte: 'svelte'
}

export function codeLanguageFromExtension(extension?: string): string {
  return (extension && LANGUAGES[extension.toLowerCase()]) || 'plaintext'
}

export function codeLanguageFromPath(path: string): string {
  const name = path.split(/[\\/]/).pop() || ''
  const dot = name.lastIndexOf('.')
  return codeLanguageFromExtension(dot > 0 ? name.slice(dot + 1) : undefined)
}
