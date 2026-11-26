# hono-irc

An IRC server on Cloudflare Workers and Durable Objects, built with [Hono](https://hono.dev) and [tcp-hono](https://github.com/yusukebe/tcp-hono). It also runs on Node.js.

> [!WARNING]
> This is an experiment. It has no TLS, no authentication, and no flood protection. Do not expose it as is.

```sh
pnpm install
pnpm dev        # Cloudflare Workers, with `cf dev`
pnpm dev:node   # Node.js
```

Connect with any IRC client to `localhost:6667` without TLS.

```sh
$ nc -C localhost 6667
NICK alice
USER alice 0 * :Alice
JOIN #hono
PRIVMSG #hono :Hello!
```

## How it works

Cloudflare Workers accept inbound TCP connections with the [`connect()` handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/connect/). `tcp-hono` turns each message on a connection into a `Request` and routes it with Hono, so an IRC command is a route:

```ts
app.on('TCP', '/PRIVMSG/:targets/:text', (c) => { ... })
```

| File                                   | Role                                                                |
| -------------------------------------- | ------------------------------------------------------------------- |
| [`src/protocol.ts`](./src/protocol.ts) | The IRC protocol for `tcp-hono`: framing, `parse()`, and `format()` |
| [`src/server.ts`](./src/server.ts)     | The server. A Hono app that does not depend on a runtime            |
| [`src/index.ts`](./src/index.ts)       | Cloudflare Workers: the Worker and the Durable Object               |
| [`src/node.ts`](./src/node.ts)         | Node.js                                                             |

- The replies to the sender are the response of the handler: `c.render(['332', channel, topic])`. The nickname of the client is inserted into a numeric reply.
- The messages to the others are pushed to their connections with `connection.send()`.
- On Cloudflare Workers, the `connect()` handler of the Worker pipes the socket to the `connect()` handler of one Durable Object. The object holds all the connections, which is why a message from a client can be written to the sockets of the others.
- The users and the channels are in memory. An IRC channel disappears when the last member leaves, so nothing needs to be stored as long as the Durable Object stays in memory while it has a connection. A deploy or a restart of the object disconnects everyone, and the clients reconnect.

## The fork of tcp-hono

`tcp-hono` writes a response only for a message, and IRC needs to write to a socket at any time. This depends on the [`server-push` branch](https://github.com/neiltron/tcp-hono/tree/server-push) of a fork, which adds `getConnection(c)`, `connection.send()`, and the `onOpen`/`onClose` hooks, and nothing specific to IRC.

The dependency is pinned to a commit, and pnpm builds it on install. To update it, change the commit hash in two places: `dependencies` in `package.json` and `allowBuilds` in `pnpm-workspace.yaml`.

## What is implemented

- Registration: `CAP`, `NICK`, `USER`, `PASS` (ignored), `PING`, `PONG`, `QUIT`
- Channels: `JOIN`, `PART`, `TOPIC`, `NAMES`, `LIST`, `KICK`, `MODE` (`+o`, `+v`, `+m`, `+n`, `+t`)
- Messages: `PRIVMSG`, `NOTICE`, `AWAY`
- Queries: `WHO`, `WHOIS`, `MOTD`, `LUSERS`
- IRCv3: capability negotiation 3.2, `server-time`, `echo-message`, `multi-prefix`, `userhost-in-names`, `extended-join`, `away-notify`
- A client that does not answer a `PING` is disconnected.

## What is not implemented

- TLS. According to the Cloudflare documentation, Spectrum terminates TLS for a Worker only with the Enterprise add-on, and `startTls()` is not supported for an inbound socket.
- Accounts (`SASL`), bans, invites, keys, operators, and server-to-server links.
- The address of the client. The Durable Object does not see it, so every user gets a random host.
- The other IRCv3 extensions, such as `message-tags`, `batch`, `labeled-response`, `chathistory`, and the WebSocket transport.

## Deploying

This has only been run locally. In production, a [Spectrum application with a Worker origin](https://developers.cloudflare.com/spectrum/how-to/route-tcp-traffic-to-a-worker/) routes a TCP port of a hostname to the `connect()` handler. It needs a paid zone.

## Development

```sh
pnpm test        # vp test
pnpm check       # vp check: format, lint, and type check
pnpm typecheck   # with the types of Cloudflare Workers
```

Node.js 24 or later is required.
