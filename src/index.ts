import { DurableObject } from 'cloudflare:workers'
import { createServer } from './server.ts'

type Env = {
  NETWORK: DurableObjectNamespace<Network>
}

/**
 * The IRC server. All the connections are held by one Durable Object, so it can write
 * a message from a client to the sockets of the others.
 *
 * The users and the channels are in memory. A channel disappears when the last member leaves,
 * so they do not need to be stored while the object has a connection.
 */
export class Network extends DurableObject<Env> {
  #server = createServer()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    setInterval(this.#server.tick, 30_000)
  }

  // The socket is piped from the Worker, so the object does not know the address of the client.
  connect(socket: Socket): Promise<void> {
    return this.#server.connect(socket)
  }
}

export default {
  // The Worker only connects the client to the Durable Object.
  async connect(socket: Socket, env: Env): Promise<void> {
    const network = env.NETWORK.getByName('default').connect('irc:6667', { allowHalfOpen: true })
    try {
      await network.opened
      await Promise.all([
        socket.readable.pipeTo(network.writable),
        network.readable.pipeTo(socket.writable),
      ])
    } finally {
      await Promise.allSettled([socket.close(), network.close()])
    }
  },
}
