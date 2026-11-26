# hono-irc

An IRC server on Cloudflare Workers and Durable Objects, built with [Hono](https://hono.dev) and [tcp-hono](https://github.com/yusukebe/tcp-hono). It also runs on Node.js.

> [!WARNING]
> This is an experiment. It has no TLS over TCP and no authentication, and only basic flood protection. Do not expose it as is.

```sh
pnpm install
pnpm dev        # Cloudflare Workers, with `cf dev`
pnpm dev:node   # Node.js, on the port of `PORT` or 6667
```

Connect with any IRC client to `localhost:6667` without TLS, or with a web client to `ws://localhost:5173/` (Cloudflare Workers only, see [WebSocket](#websocket)).

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

| File                                                             | Role                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [`src/protocol.ts`](./src/protocol.ts)                           | The IRC protocol for `tcp-hono`: framing, `parse()`, and `format()`       |
| [`src/numerics.ts`](./src/numerics.ts)                           | The names of the numeric replies                                          |
| [`src/state.ts`](./src/state.ts)                                 | `Client`, `Channel`, and `Server`: the state, the registries, and helpers |
| [`src/server.ts`](./src/server.ts)                               | `createServer()`. A Hono app that does not depend on a runtime            |
| [`src/flood.ts`](./src/flood.ts)                                 | The flood control: a token bucket and fake lag for each connection        |
| [`src/cloak.ts`](./src/cloak.ts)                                 | The cloaks: the hosts shown in place of the addresses, with HMAC-SHA-256  |
| [`src/masks.ts`](./src/masks.ts)                                 | The masks of bans and exceptions: `nick!user@host` with `*` and `?`       |
| [`src/commands/registration.ts`](./src/commands/registration.ts) | `CAP`, `NICK`, `USER`, `PASS`, `PING`, `PONG`, `QUIT`                     |
| [`src/commands/channels.ts`](./src/commands/channels.ts)         | `JOIN`, `PART`, `TOPIC`, `NAMES`, `LIST`, `KICK`, `INVITE`                |
| [`src/commands/messages.ts`](./src/commands/messages.ts)         | `PRIVMSG`, `NOTICE`, `TAGMSG`, `AWAY`                                     |
| [`src/commands/multiline.ts`](./src/commands/multiline.ts)       | `BATCH` from a client: the batches of `draft/multiline`                   |
| [`src/commands/modes.ts`](./src/commands/modes.ts)               | `MODE`                                                                    |
| [`src/commands/queries.ts`](./src/commands/queries.ts)           | `WHO`, `WHOIS`, `ISON`, `USERHOST`, `MOTD`, `LUSERS`                      |
| [`src/websocket.ts`](./src/websocket.ts)                         | The IRCv3 WebSocket transport: a WebSocket as a socket of `tcp-hono`      |
| [`src/index.ts`](./src/index.ts)                                 | Cloudflare Workers: the Worker and the Durable Object                     |
| [`src/node.ts`](./src/node.ts)                                   | Node.js                                                                   |
| [`scripts/e2e.mjs`](./scripts/e2e.mjs)                           | A smoke test with a real client library, `irc-framework`                  |

- Each file in `src/commands` is a Hono app, and `src/server.ts` mounts them with `app.route()`.
- A message to a client is sent with `client.send(message)` or `channel.send(message)`. While a client's own command is handled, the messages to it, and the replies of `c.render(['332', channel, topic])`, are collected in order and written as the response. The nickname of the client is inserted into a numeric reply.
- The messages to the others are pushed to their connections with `connection.send()`.
- A message tag is sent only to a client that has the capability of the tag, such as `server-time` for `time`, and a client-only tag (`+name`) only to a client that has `message-tags`. The capabilities, the `RPL_ISUPPORT` tokens, and the tags are registered in `Server`, and `client.format()` filters them.
- The `label` of `labeled-response` is added by the same middleware, to the messages of the outbox, which are exactly what the command caused: one line gets the label, none gets `ACK`, and more are put in a `labeled-response` batch. So every command is covered, including the errors, `421`, `417`, and the `ERROR` of `QUIT`. A message to the client that its command did not answer, such as its own private message to itself, is sent with `client.send(message, false)` and stays out of the response.
- `client.sendBatch()` sends messages as a batch to a client that has `batch`, and as single lines to the others. The standard replies are lines such as `fail('BATCH', 'TIMEOUT', ref, 'description')`, rendered like numerics.
- A runtime hands over a socket with `connect(socket, info)` of the server.
- On Cloudflare Workers, the `connect()` handler of the Worker pipes the socket to the `connect()` handler of one Durable Object. The object holds all the connections, which is why a message from a client can be written to the sockets of the others.
- A WebSocket goes to the same object: the `fetch()` handler of the Worker forwards the upgrade request to it, and `fromWebSocket()` of `src/websocket.ts` turns the WebSocket into a socket for the same `connect()` of the server. A WebSocket client and a TCP client are in the same channels.
- The users and the channels are in memory. An IRC channel disappears when the last member leaves, so nothing needs to be stored as long as the Durable Object stays in memory while it has a connection. A deploy or a restart of the object disconnects everyone, and the clients reconnect.

## WebSocket

The Worker serves the [IRCv3 WebSocket transport](https://ircv3.net/specs/extensions/websocket) at `/`, which web clients such as [gamja](https://codeberg.org/emersion/gamja) speak. A `GET /` without an upgrade describes the server in plain text.

- `pnpm dev` serves it at `ws://localhost:5173/`. Deployed, it is `wss://hono-irc.<subdomain>.workers.dev/`, which has TLS on any plan.
- Each WebSocket message is one IRC line without CRLF. The subprotocols are `text.ircv3.net` (text messages, UTF-8) and `binary.ircv3.net` (binary messages, any bytes). The server sends only UTF-8, as `UTF8ONLY` says, and rejects a line from a client that is not UTF-8, which only a binary message can carry, as over TCP. The first one that the client offers wins. A client that offers neither is accepted without a subprotocol, and gets the type of its own first message, or text before that.
- A line has the same limits as over TCP: a message longer than 4096 bytes of tags and 510 bytes of the rest gets `ERR_INPUTTOOLONG`, and the connection stays open. A message with a line break inside, or longer than 64 KiB, closes the connection. So does a client that sends faster than the server reads, or does not read what is sent to it, beyond 1 MiB, like `maxBufferedBytes` of `tcp-hono` for TCP.
- Any `Origin` is allowed. The server reads no cookies and no HTTP authentication, so a page on another origin can do nothing that it could not do by connecting directly. `src/index.ts` explains it.
- The object accepts the WebSocket with `accept()`, not with the hibernation API, because the state is in memory and a hibernated object would lose it.

To try it with gamja, run gamja from its repository and open it with the URL parameter `server`, e.g. `http://localhost:8080/?server=ws://localhost:5173/` (the port is the one of the gamja server). It has not been tried with gamja; the tests use a WebSocket client of Node.js.

Under `cf dev`, the WebSocket goes through a proxy of the Vite plugin, which differs from Cloudflare in two ways:

- It answers the client with the first subprotocol that the client offers, whatever the Worker chose, and fails the connection when the Worker answers with none. So a client whose first offer is neither IRCv3 subprotocol is told that one, while the server uses the one it negotiated, and a client that offers only unknown subprotocols cannot connect. A client that offers no subprotocol, or an IRCv3 one first, is not affected.
- The address of every WebSocket client is `127.0.0.1`, and a client can set it, and `https`, with the headers `CF-Connecting-IP` and `X-Forwarded-Proto`. On Cloudflare, these come from the edge.

## The fork of tcp-hono

`tcp-hono` writes a response only for a message, and IRC needs to write to a socket at any time. This depends on the [`server-push` branch](https://github.com/neiltron/tcp-hono/tree/server-push) of a fork, which adds `getConnection(c)`, `connection.send()`, and the `onOpen`/`onClose` hooks, and nothing specific to IRC.

The dependency is pinned to a commit, and pnpm builds it on install. To update it, change the commit hash in two places: `dependencies` in `package.json` and `allowBuilds` in `pnpm-workspace.yaml`.

## What is implemented

- Registration: `CAP`, `NICK`, `USER`, `PASS` (not checked), `PING`, `PONG`, `QUIT`
- Channels: `JOIN` (with keys), `PART`, `TOPIC`, `NAMES`, `LIST`, `KICK`, `INVITE`, and `MODE` with `CHANMODES=beI,k,l,imnst` and `PREFIX=(ov)@+`:
  - `+b` bans, `+e` ban exceptions, and `+I` invite exceptions: masks `nick!user@host` with `*` and `?`, in ASCII case, kept in their full form (`bob` is `bob!*@*`, `*@host` is `*!*@host`). A backslash escapes `*`, `?`, and `\`. `MODE #channel b` lists the bans to anyone who can see the channel, and `e` and `I` only to its operators.
  - A banned client can not join (`ERR_BANNEDFROMCHAN`), send to the channel from inside or outside, or change its nickname while it is in the channel (`ERR_BANNICKCHANGE`, 435), unless it is an operator or has voice there. An exception (`+e`) cancels a ban.
  - `+i`: only an invited client, or one that matches an invite exception, can join. Any member can invite to a channel without `+i`, and only an operator to one with it. An invite lets the client in in spite of `+i`, `+k`, and `+l`, but not of a ban, and is used up when it joins. `INVITE` without parameters lists the invites of the client. A client keeps its last 50 invites, which go away with it and with the channel.
  - `+k` and `+l`: `JOIN #a,#b key1,key2`. A key is at most `KEYLEN` (23) bytes, without a comma, and is shown in `MODE #channel` only to the members. `-k` takes a parameter, as a mode of type B, and the server sends `-k *`.
  - `+s`: a secret channel is left out of `LIST`, `NAMES`, `WHO`, `WHOIS`, and `TOPIC` for those outside it.
  - `MODES=4`: a `MODE` command applies at most four changes with a parameter, and ignores the others. `MAXLIST=beI:100`: the three lists of a channel have at most 100 masks together, and a mask is at most 100 bytes. A long change is sent in as many `MODE` lines as it takes.
- Users: `MODE` (`+i`: an invisible user is left out of `NAMES` and `WHO` of a channel for those outside it)
- Messages: `PRIVMSG`, `NOTICE`, `TAGMSG`, `AWAY`, and multiline messages
- Queries: `WHO`, `WHOIS`, `ISON`, `USERHOST`, `MOTD`, `LUSERS`
- IRCv3: capability negotiation 3.2, `cap-notify`, `server-time`, `echo-message`, `multi-prefix`, `userhost-in-names`, `extended-join`, `away-notify`, `invite-notify`, `no-implicit-names`, `message-tags`, `message-ids`, `batch`, `labeled-response`, `standard-replies`, `draft/multiline`, `UTF8ONLY`, and the WebSocket transport (Cloudflare Workers only)
  - `message-tags`: the client-only tags of `PRIVMSG`, `NOTICE`, and `TAGMSG` are relayed to the clients that have the capability, whether the sender has it or not, and `TAGMSG` is delivered only to them. The other tags of a client are never relayed. `CLIENTTAGDENY=` says that every client-only tag is allowed. `TAGMSG` is answered like `PRIVMSG`, without `RPL_AWAY`.
  - `msgid`: every `PRIVMSG`, `NOTICE`, `TAGMSG`, and multiline message has one, the same for all its recipients and the echo, and one for each target. It is like a ULID: the time in milliseconds and 80 random bits, so the IDs sort by time and do not repeat after a restart.
  - `labeled-response` is used only when the client also has `batch`, which it depends on. A label longer than 64 bytes is ignored. A message to oneself with `echo-message` comes twice, the delivered one without the label and the echo with it.
  - `draft/multiline` (`max-bytes=4096,max-lines=100` by default): a batch is checked as it comes and delivered when it ends, with the checks of `PRIVMSG` done once for the whole message. A client that does not have the capability, or `batch`, gets the lines one by one, without the blank ones, and with the message ID and the client-only tags on the first one. A batch that breaks a rule gets a `FAIL` and the rest of it is ignored, and so are the lines of a batch that is not open. One batch can be open at a time; it is dropped after `timeout` (30 seconds, checked by `tick()`) and on a disconnection. The other commands are handled as usual while a batch is open. The sender needs `draft/multiline` and `batch`.
  - `UTF8ONLY`: a line that is not UTF-8 gets `FAIL <command> INVALID_UTF8` and is not handled, and the client stays. A `QUIT` is handled without its reason.
  - `invite-notify`: the members of the channel that have it get the `INVITE` too.
- `CASEMAPPING=ascii`. The lengths of `NICKLEN`, `CHANNELLEN`, `TOPICLEN`, `AWAYLEN`, `KICKLEN`, and `KEYLEN` are in bytes.
- Lines: a client can send 4096 bytes of tags and 512 bytes of the rest. A longer line gets `ERR_INPUTTOOLONG` and is dropped. A line from the server is at most 512 bytes without the tags: a longer last parameter is cut. The tags that the server adds come first and are far below their 4094 bytes, and the relayed client-only tags are at most 4094 bytes, so a line has at most 8191 bytes of tags.
- Targets: `PRIVMSG`, `NOTICE`, `TAGMSG`, and `KICK` take up to four, and `NAMES`, `WHO`, and `WHOIS` one, as `TARGMAX` shows. A repeated target counts once.
- The address of the client is passed to the server, from `CF-Connecting-IP` for a WebSocket and from the Worker for TCP (see below). It is not shown to the other users, who see a cloak (see below).
- A client that does not answer a `PING` is disconnected, and so is one that has not registered in time after it connected.
- Limits, set with the options of `createServer()`:
  - `flood`: a token bucket for each connection, by default 10 commands at once and one more every 2 seconds, with `NICK`, `JOIN`, and `PART` taking more. A client that runs out is not disconnected: its commands wait until the tokens are back (fake lag), so a burst is handled in full and in order, only slower. The others are not slowed down. `false` turns it off. The lines of a multiline batch are free, and the batch takes one token for every 512 bytes or every 5 lines, whichever is more, when it ends.
  - `multiline`: `maxBytes` (4096), `maxLines` (100), and `timeout` (30 seconds) of a `draft/multiline` batch.
  - `maxConnections` (1000), `maxConnectionsPerIp` (10, when the runtime knows the address), and `maxChannels` (1000).

## What is not implemented

- TLS over TCP. According to the Cloudflare documentation, Spectrum terminates TLS for a Worker only with the Enterprise add-on, and `startTls()` is not supported for an inbound socket. A WebSocket has TLS (`wss://`) once deployed, which has not been tried.
- Accounts (`SASL`), operators, and server-to-server links. So there are no extended bans, such as by account.
- The WebSocket transport on Node.js, which has no WebSocket server built in. `src/websocket.ts` does not depend on a runtime.
- The other IRCv3 extensions, such as `chathistory`, `account-tag`, and `STATUSMSG`. No standard reply is sent beyond what a spec defines, so `standard-replies` changes nothing yet.
- `ELIST`, and the parameters of `LIST`. `WHO` with a mask that is not a channel or a nickname. `KNOCK`.

## The address of the client

For a WebSocket, the address is `CF-Connecting-IP`, which Cloudflare sets. Under `cf dev`, it is `127.0.0.1` (see [WebSocket](#websocket)).

The Durable Object does not see a TCP client: the Worker pipes the socket to it. So the Worker connects to the object with the address of the client, `remoteAddress` of its socket (`192.0.2.1:4242` or `[2001:db8::1]:4242`), as the address to connect to, which the object receives as `localAddress`. Only the Worker sets it, so the bytes from a client can not forge it. When `remoteAddress` is missing, which the documentation allows for a connection from Spectrum, the address is unknown.

This has been tried under `cf dev` with IPv4 clients, and the address strings of IPv6 have been passed through `connect()`, but not from an IPv6 client. It has not been tried deployed.

### Cloaks

The other users see a cloak in place of the address: `<address>.<network>.<wider network>.ip4`, where each label is 32 bits of HMAC-SHA-256 of a part of the address with the key `cloakSecret` of `createServer()`. The parts are the /32, the /24, and the /16 for IPv4, and the /128, the /64, and the /48 for IPv6 (with `.ip6`). An IPv4 address mapped to IPv6 is cloaked as IPv4.

- A client gets the same cloak each time it connects from the same address, so a ban on its host holds. The clients of a network share the end of their cloaks, so `*!*@*.<network>.<wider network>.ip4` bans a /24 (or a /64).
- Without the key, nobody can tell the address from a cloak, or work out the cloak of an address to compare it.
- The hash is in plain JavaScript (`src/cloak.ts`), because a client is made synchronously when it connects, and the digests of WebCrypto are asynchronous. The tests compare it with `node:crypto`.
- The Durable Object makes the key once and keeps it in its storage, with the synchronous KV API of SQLite-backed objects, so the cloaks stay the same across restarts and deploys. On Node.js, the key is random for each process unless `cloakSecret` is given.
- A client whose address is unknown gets a random host, `<random>.user`, which changes on each connection.

## Deploying

This has only been run locally. In production, a [Spectrum application with a Worker origin](https://developers.cloudflare.com/spectrum/how-to/route-tcp-traffic-to-a-worker/) routes a TCP port of a hostname to the `connect()` handler. It needs a paid zone. The WebSocket transport needs only the Worker, on workers.dev or a custom domain.

## Development

```sh
pnpm test        # vp test
pnpm check       # vp check: format, lint, and type check
pnpm typecheck   # with the types of Cloudflare Workers
PORT=6701 pnpm dev:node & pnpm e2e 127.0.0.1 6701   # a smoke test with irc-framework
```

Node.js 24 or later is required.
