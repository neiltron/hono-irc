import { createServer as createListener } from 'node:net'
import { Duplex } from 'node:stream'
import type { Socket } from 'tcp-hono'
import { createServer } from './server.ts'

// Node.js
const server = createServer()

// This does what `tcp()` of `tcp-hono/node` does, and also passes the address of the client
// to `connect()`. The adapter does not expose the socket.
const listener = createListener({ allowHalfOpen: true }, (socket) => {
  socket.on('error', () => {})
  const { readable, writable } = Duplex.toWeb(socket)
  // The types of the Web streams of Node.js differ from the global ones of Cloudflare Workers,
  // which the type check of the project includes.
  void server.connect(
    { readable, writable, close: () => void socket.destroy() } as unknown as Socket,
    { ip: socket.remoteAddress, secure: false }
  )
})
listener.listen(6667, () => {
  console.log('Listening on irc://localhost:6667')
})
setInterval(server.tick, 30_000)
