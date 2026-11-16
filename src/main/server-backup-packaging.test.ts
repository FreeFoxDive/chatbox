import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return []
  const found: string[] = []
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const path = join(directory, entry)
    const info = statSync(path)
    if (info.isDirectory()) found.push(...sourceFiles(path))
    else if (/\.(ts|tsx|js|cjs|mjs)$/.test(entry)) found.push(path)
  }
  return found
}

describe('backup server packaging', () => {
  it('does not ship the server directory inside the client', () => {
    const builder = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    const files = builder.split('extraResources:')[0] ?? ''
    expect(files).not.toMatch(/server\//)
    expect(builder).not.toMatch(/extraResources:[\s\S]*server\//)
    expect(readFileSync(join(root, 'tsconfig.json'), 'utf8')).toMatch(/"server"/)
    expect(existsSync(join(root, 'release/app/server'))).toBe(false)
    for (const file of [...sourceFiles(join(root, 'src')), ...sourceFiles(join(root, 'release/app'))]) {
      if (file.includes(`${join('release', 'app', 'node_modules')}`)) continue
      const text = readFileSync(file, 'utf8')
      expect(text).not.toMatch(/from ['"][^'"]*\/server\/src/)
      expect(text).not.toMatch(/from ['"]server\//)
    }
  })
})
