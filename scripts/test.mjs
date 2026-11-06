import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

let failed = 0
for (const file of readdirSync(new URL('../tests/', import.meta.url)).filter(f => f.endsWith('.mjs')).sort()) {
  const run = spawnSync(process.execPath, [new URL('../tests/' + file, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')], { encoding: 'utf8' })
  console.log(run.stdout)
  if (run.status !== 0) { failed++; console.error(run.stderr) }
}
process.exitCode = failed ? 1 : 0
