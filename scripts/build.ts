#!/usr/bin/env bun
/**
 * The production bundle (single file, `bun build --target=bun`).
 *
 * react-devtools-core is stubbed to an empty module: ink only loads it when
 * the DEV env var is set, and degrades to a console warning when the module
 * misbehaves — the shipped CLI must not carry (or ever start) a devtools
 * WebSocket backend.
 */
const result = await Bun.build({
  target: 'node',
  entrypoints: [new URL('../src/entry.tsx', import.meta.url).pathname],
  outdir: new URL('../dist', import.meta.url).pathname,
  plugins: [
    {
      name: 'stub-react-devtools-core',
      setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, (args) => ({ path: args.path, namespace: 'stub-devtools' }))
        build.onLoad({ filter: /.*/, namespace: 'stub-devtools' }, () => ({
          contents: 'export default { initialize() {}, connectToDevTools() {} }',
          loader: 'js',
        }))
      },
    },
  ],
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
for (const out of result.outputs) console.error(`built ${out.path}`)
