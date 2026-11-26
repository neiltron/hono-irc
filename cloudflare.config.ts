import { bindings, defineConfig, exports, triggers } from 'cf/config'
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' }

const name = 'hono-irc'

export default defineConfig({
  worker: {
    name,
    // From 2026-04-07, the runtime answers the closing handshake of a WebSocket by itself,
    // which `src/websocket.ts` relies on.
    compatibilityDate: '2026-11-17',
    entrypoint,
    // The `fetch()` handler serves the WebSocket transport over HTTP. `cf dev` serves it on
    // the port of the dev server (5173), and a deploy on workers.dev, which has TLS (`wss://`).
    workersDev: true,
    // The listener for local development. In production, a Spectrum application with
    // a Worker origin routes the TCP connections to the `connect()` handler.
    triggers: [triggers.connect({ protocol: 'tcp', port: 6667 })],
    exports: {
      Network: exports.durableObject({ storage: 'sqlite' }),
    },
    env: {
      NETWORK: bindings.durableObject({ worker: name, exportName: 'Network' }),
    },
  },
})
