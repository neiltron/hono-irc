# hono-irc

An IRC server on Cloudflare Workers and Durable Objects, built with [Hono](https://hono.dev) and [tcp-hono](https://github.com/yusukebe/tcp-hono). It also runs on Node.js.

> [!WARNING]
> This is an experiment. It has no TLS over TCP, so a password sent over TCP (`AUTHENTICATE PLAIN`, `REGISTER`) is in the clear, and only basic flood protection. Do not expose it as is.

```sh
pnpm install
pnpm dev        # Cloudflare Workers, with `cf dev`
pnpm dev:node   # Node.js, on the port of `PORT` or 6667, with the database in the SQLite file of `DATABASE`, or in memory
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
| [`src/store.ts`](./src/store.ts)                                 | The database: a synchronous SQL interface on SQLite, and the migrations   |
| [`src/accounts.ts`](./src/accounts.ts)                           | The accounts: the hashes of the passwords, the storage, and the limits    |
| [`src/history.ts`](./src/history.ts)                             | The stored messages and read markers: the queries and the retention       |
| [`src/channels-store.ts`](./src/channels-store.ts)               | The permanent channels (`+P`) in the database                             |
| [`src/cloak.ts`](./src/cloak.ts)                                 | The cloaks: the hosts shown in place of the addresses, with HMAC-SHA-256  |
| [`src/masks.ts`](./src/masks.ts)                                 | The masks of bans and exceptions: `nick!user@host` with `*` and `?`       |
| [`src/commands/registration.ts`](./src/commands/registration.ts) | `CAP`, `NICK`, `USER`, `PASS`, `PING`, `PONG`, `QUIT`                     |
| [`src/commands/channels.ts`](./src/commands/channels.ts)         | `JOIN`, `PART`, `TOPIC`, `NAMES`, `LIST`, `KICK`, `INVITE`                |
| [`src/commands/messages.ts`](./src/commands/messages.ts)         | `PRIVMSG`, `NOTICE`, `TAGMSG`, `AWAY`                                     |
| [`src/commands/multiline.ts`](./src/commands/multiline.ts)       | `BATCH` from a client: the batches of `draft/multiline`                   |
| [`src/commands/modes.ts`](./src/commands/modes.ts)               | `MODE`                                                                    |
| [`src/commands/queries.ts`](./src/commands/queries.ts)           | `WHO` (with WHOX), `WHOIS`, `ISON`, `USERHOST`, `MOTD`, `LUSERS`          |
| [`src/commands/monitor.ts`](./src/commands/monitor.ts)           | `MONITOR`                                                                 |
| [`src/commands/setname.ts`](./src/commands/setname.ts)           | `SETNAME`                                                                 |
| [`src/commands/sasl.ts`](./src/commands/sasl.ts)                 | `AUTHENTICATE`: SASL and its mechanisms, of which `PLAIN`                 |
| [`src/commands/account.ts`](./src/commands/account.ts)           | `REGISTER` and `VERIFY`: account registration                             |
| [`src/commands/chathistory.ts`](./src/commands/chathistory.ts)   | `CHATHISTORY` (`draft/chathistory`), and `replayOnJoin`                   |
| [`src/commands/markread.ts`](./src/commands/markread.ts)         | `MARKREAD` (`draft/read-marker`)                                          |
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
- A handler is synchronous, so the outbox holds exactly what its command caused. The slow, asynchronous work of a command, such as hashing a password with WebCrypto, is a prepare step in `server.prepare`, which the middleware runs before it opens the outbox, as the flood control waits there, and hands to the handler as `c.var.prepared`. The handler reads the state again and decides.
- A runtime hands over a socket with `connect(socket, info)` of the server.
- On Cloudflare Workers, the `connect()` handler of the Worker pipes the socket to the `connect()` handler of one Durable Object. The object holds all the connections, which is why a message from a client can be written to the sockets of the others.
- A WebSocket goes to the same object: the `fetch()` handler of the Worker forwards the upgrade request to it, and `fromWebSocket()` of `src/websocket.ts` turns the WebSocket into a socket for the same `connect()` of the server. A WebSocket client and a TCP client are in the same channels.
- The users and the channels are in memory. An ordinary IRC channel disappears when the last member leaves. A deploy or a restart of the object disconnects everyone, and the clients reconnect.
- The accounts, the permanent channels, the messages, and the read markers are stored, in the SQLite database of the Durable Object, or of `node:sqlite` on Node.js (see [Accounts](#accounts) and [History and permanent channels](#history-and-permanent-channels)). A handler writes what it changes as it changes it, synchronously.
- Every `PRIVMSG`, `NOTICE`, and `TAGMSG`, single or multiline, goes through `deliver()` of `src/commands/messages.ts`, which decides, stores the message once, and sends it to each recipient with `present()`. A message that is played back from the history goes through `present()` too, so the rules of the capabilities are the same.

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
- Accounts: `AUTHENTICATE` (SASL `PLAIN`), `REGISTER`, `VERIFY`, and the nicknames that the accounts reserve (see [Accounts](#accounts))
- Channels: `JOIN` (with keys), `PART`, `TOPIC`, `NAMES`, `LIST`, `KICK`, `INVITE`, and `MODE` with `CHANMODES=beI,k,l,Pimnst` (`imnst` without a database) and `PREFIX=(ov)@+`:
  - `+P`: a permanent channel, which is stored and stays when it is empty (see [History and permanent channels](#history-and-permanent-channels)).
  - `+b` bans, `+e` ban exceptions, and `+I` invite exceptions: masks `nick!user@host` with `*` and `?`, in ASCII case, kept in their full form (`bob` is `bob!*@*`, `*@host` is `*!*@host`). A backslash escapes `*`, `?`, and `\`. `MODE #channel b` lists the bans to anyone who can see the channel, and `e` and `I` only to its operators.
  - A banned client can not join (`ERR_BANNEDFROMCHAN`), send to the channel from inside or outside (`PRIVMSG`, `NOTICE`, `TAGMSG`, or a multiline message), or change its nickname while it is in the channel (`ERR_BANNICKCHANGE`, 435), unless it is an operator or has voice there. An exception (`+e`) cancels a ban.
  - `+i`: only an invited client, or one that matches an invite exception, can join. Any member can invite to a channel without `+i`, and only an operator to one with it. An invite lets the client in in spite of `+i`, `+k`, and `+l`, but not of a ban, and is used up when it joins. `INVITE` without parameters lists the invites of the client. A client keeps its last 50 invites, which go away with it and with the channel.
  - `+k` and `+l`: `JOIN #a,#b key1,key2`. A key is at most `KEYLEN` (23) bytes, without a comma, and is shown in `MODE #channel` only to the members. `-k` takes a parameter, as a mode of type B, and the server sends `-k *`.
  - `+s`: a secret channel is left out of `LIST`, `NAMES`, `WHO`, `WHOIS`, and `TOPIC` for those outside it.
  - `MODES=4`: a `MODE` command applies at most four changes with a parameter, and ignores the others. `MAXLIST=beI:100`: the three lists of a channel have at most 100 masks together, and a mask is at most 100 bytes. A long change is sent in as many `MODE` lines as it takes.
- Users: `MODE` with `+i` (an invisible user is left out of `NAMES` and `WHO` of a channel for those outside it) and `+B` (bot mode)
- Messages: `PRIVMSG`, `NOTICE`, `TAGMSG`, `AWAY`, and multiline messages
- Queries: `WHO` (with WHOX), `WHOIS`, `ISON`, `USERHOST`, `MOTD`, `LUSERS`, `MONITOR`
- IRCv3: capability negotiation 3.2, `cap-notify`, `server-time`, `echo-message`, `multi-prefix`, `userhost-in-names`, `extended-join`, `away-notify`, `invite-notify`, `monitor`, `extended-monitor`, `setname`, `bot-mode`, `no-implicit-names`, WHOX, `message-tags`, `message-ids`, `batch`, `labeled-response`, `standard-replies`, `draft/multiline`, `UTF8ONLY`, `sasl` (3.1 and 3.2), `draft/account-registration`, `account-notify`, `account-tag`, `draft/chathistory` with the `chathistory` batch, `draft/read-marker`, and the WebSocket transport (Cloudflare Workers only)
  - `message-tags`: the client-only tags of `PRIVMSG`, `NOTICE`, and `TAGMSG` are relayed to the clients that have the capability, whether the sender has it or not, and `TAGMSG` is delivered only to them. The other tags of a client are never relayed, and neither is a client-only tag whose key is not of the grammar of the spec (`+`, an optional vendor that is a host name and `/`, and letters, digits, and hyphens): it is dropped, and the message relayed without it. `CLIENTTAGDENY=` says that every client-only tag is allowed. `TAGMSG` is answered like `PRIVMSG`, without `RPL_AWAY`.
  - `msgid`: every `PRIVMSG`, `NOTICE`, `TAGMSG`, and multiline message has one, the same for all its recipients and the echo, and one for each target. It is like a ULID: the time in milliseconds and 80 random bits, so the IDs sort by time and do not repeat after a restart.
  - `labeled-response` is used only when the client also has `batch`, which it depends on. A label longer than 64 bytes is ignored. A message to oneself with `echo-message` comes twice, the delivered one without the label and the echo with it.
  - `draft/multiline` (`max-bytes=4096,max-lines=100` by default): a batch is checked as it comes and delivered when it ends, with the checks of `PRIVMSG` done once for the whole message. A client that does not have the capability, or `batch`, gets the lines one by one, without the blank ones, and with the message ID and the client-only tags on the first one. A batch that breaks a rule gets a `FAIL` and the rest of it is ignored, and so are the lines of a batch that is not open. One batch can be open at a time; it is dropped after `timeout` (30 seconds, checked by `tick()`) and on a disconnection. The other commands are handled as usual while a batch is open. The sender needs `draft/multiline` and `batch`.
  - `UTF8ONLY`: a line that is not UTF-8 gets `FAIL <command> INVALID_UTF8` and is not handled, and the client stays. A `QUIT` is handled without its reason.
- A line with a NUL, or a CR that does not end it, which Modern IRC allows nowhere in a message, gets `ERR_UNKNOWNERROR` (400) `<command> :Line contains a forbidden character (NUL or CR)` and is not handled, as one that is not UTF-8, rather than read one way here and another way by a client that splits lines on a CR. A `QUIT` is handled without its reason. A line of a multiline batch fails the batch.
  - `invite-notify`: the members of the channel that have it get the `INVITE` too.
  - WHOX: `WHO <mask> %<fields>[,<token>]` replies with `RPL_WHOSPCRPL` (354). The address (`i`) is `255.255.255.255`, the account (`a`) is `0` for a client that is not logged in, and the op level (`o`) is `n/a`. A token that is not one to three digits is ignored, and `t` is then `0`.
  - `MONITOR=100`. A client is told when a nickname that it monitors registers, changes to or from it, or quits.
  - `extended-monitor`: a client that monitors another gets its `AWAY` with `away-notify`, its `ACCOUNT` with `account-notify`, and its `SETNAME` with `setname`, without sharing a channel.
  - `setname`: `SETNAME` changes the realname, which is at most `NAMELEN` (150) bytes, as is the one of `USER`. A realname that is not valid gets `FAIL SETNAME INVALID_REALNAME`.
  - Bot mode: `BOT=B`, `RPL_WHOISBOT` (335) in `WHOIS`, `B` in the flags of `WHO`, and the `bot` tag, for the clients with `message-tags`, on every message whose source is a client in bot mode, including the lines of its multiline batches.
- `CASEMAPPING=ascii`. The lengths of `NICKLEN`, `CHANNELLEN`, `TOPICLEN`, `AWAYLEN`, `KICKLEN`, `KEYLEN`, and `NAMELEN` are in bytes.
- Lines: a client can send 4096 bytes of tags and 512 bytes of the rest. A longer line gets `ERR_INPUTTOOLONG` and is dropped. A line from the server is at most 512 bytes without the tags: a longer last parameter is cut. The tags that the server adds come first and are far below their 4094 bytes, and the relayed client-only tags are at most 4094 bytes, so a line has at most 8191 bytes of tags.
- Targets: `PRIVMSG`, `NOTICE`, `TAGMSG`, and `KICK` take up to four, `JOIN` ten, and `NAMES`, `WHO`, and `WHOIS` one, as `TARGMAX` shows. A repeated target counts once (in any case), and the ones over the limit get `ERR_TOOMANYTARGETS`.
- The address of the client is passed to the server, from `CF-Connecting-IP` for a WebSocket and from the Worker for TCP (see below). It is not shown to the other users, who see a cloak (see below).
- A client that does not answer a `PING` is disconnected, and so is one that has not registered in time after it connected.
- Limits, set with the options of `createServer()`:
  - `flood`: a token bucket for each connection, by default 10 commands at once and one more every 2 seconds, with `NICK`, `JOIN`, `PART`, `AUTHENTICATE`, `CHATHISTORY` (2), and `REGISTER` (3) taking more. `AUTHENTICATE` and `REGISTER`, which hash a password, take their cost before the registration too. A client that runs out is not disconnected: its commands wait until the tokens are back (fake lag), so a burst is handled in full and in order, only slower. The others are not slowed down. `false` turns it off. The lines of a multiline batch are free when they come, and the batch takes one token for every 512 bytes of its lines as they came (tags included) or every 5 lines, whichever is more, when it ends: when it closes, and also when it fails or times out, so a batch that fails is not free.
  - `multiline`: `maxBytes` (4096), `maxLines` (100), and `timeout` (30 seconds) of a `draft/multiline` batch.
  - `maxConnections` (1000), `maxConnectionsPerIp` (10, for an IPv4 address or an IPv6 /64, when the runtime knows the address), `maxConnectionsPerNetwork` (20, for an IPv6 /48), `connectionRate` (10 new connections at once from an address, as `maxConnectionsPerIp` counts it, and one more every 6 seconds, so that reconnecting does not buy a fresh flood control), and `maxChannels` (1000). A connection over a limit gets an `ERROR` and is closed.
  - `maxListEntries` (500): `LIST` shows the channels with members, the busiest first, and then the empty permanent channels, by name, up to this many. A list that is cut says so before `RPL_LISTEND`: `WARN LIST TRUNCATED` to a client with `standard-replies`, and a `NOTICE` to the others, as no spec defines a reply for it, and every client shows a notice.
  - `maxReplyBytes` (512 KiB) and `maxBufferedBytes` (1 MiB): see [Memory](#memory).
  - `accounts`: see [Accounts](#accounts).
  - `persistChannels`, `permanentChannels`, `history`, and `replayOnJoin`: see [History and permanent channels](#history-and-permanent-channels).

## What is not implemented

- TLS over TCP. According to the Cloudflare documentation, Spectrum terminates TLS for a Worker only with the Enterprise add-on, and `startTls()` is not supported for an inbound socket. A WebSocket has TLS (`wss://`) once deployed, which has not been tried.
- Operators and server-to-server links. Extended bans, such as by account.
- Of the accounts: the SASL mechanisms other than `PLAIN` (`SCRAM-SHA-256`, `EXTERNAL`), reauthentication (a client that is logged in gets `ERR_SASLALREADY`) and so logging out, email and verification, changing or resetting a password, deleting an account, `draft/ACCOUNTREQUIRED`, and rehashing a password with new parameters when it logs in.
- Always-on clients, and a way to delete what is stored about an account (an account can not be deleted either).
- `draft/event-playback`: only `PRIVMSG` and `NOTICE` are stored (see [History and permanent channels](#history-and-permanent-channels)).
- The WebSocket transport on Node.js, which has no WebSocket server built in. `src/websocket.ts` does not depend on a runtime.
- The other IRCv3 extensions, such as `chghost`, `STATUSMSG`, and the `draft/chathistory-context` messages. No standard reply is sent beyond what a spec defines, so `standard-replies` changes nothing yet.
- `ELIST`, and the parameters of `LIST`, so a client can not ask for the channels past `maxListEntries`. `WHO` with a mask that is not a channel or a nickname. `KNOCK`.

## Accounts

A client registers an account with `REGISTER` (`draft/account-registration`) and logs in to it with SASL `PLAIN` (`AUTHENTICATE`), before or after the registration of the connection.

- `REGISTER * * <password>` registers an account named after the current nickname (no `custom-account-name`), with the rules and the casemapping of the nicknames, and logs the client in, with `REGISTER SUCCESS` and `RPL_LOGGEDIN` (900). It works before the registration once the client has a nickname (`before-connect`). The email parameter is ignored and not stored, so nothing needs verification, and `VERIFY` only answers `INVALID_CODE` or `ALREADY_AUTHENTICATED`. The capability shows the limits of a password, `draft/account-registration=before-connect,min-password-length=8,max-password-length=300`; a password must also not be the name of the account, nor have a NUL, which SASL `PLAIN` could not carry. Every `FAIL` code of the spec that applies is sent: `NEED_NICK`, `BAD_ACCOUNT_NAME`, `ACCOUNT_NAME_MUST_BE_NICK`, `ACCOUNT_EXISTS`, `ALREADY_AUTHENTICATED`, `WEAK_PASSWORD`, `UNACCEPTABLE_PASSWORD`, and `TEMPORARILY_UNAVAILABLE` for the limits and for a closed registration.
- `AUTHENTICATE PLAIN` follows sasl-3.1 and sasl-3.2: `sasl=PLAIN` in `CAP LS 302`, the response in chunks of 400 bytes of base64 (`+` after a last chunk of exactly 400), at most what `PLAIN` needs (`ERR_SASLTOOLONG`, 905), `*` to abort (906), `RPL_SASLMECHS` (908) for an unknown mechanism, and `RPL_LOGGEDIN` (900) and `RPL_SASLSUCCESS` (903). The authorization identity is empty or the account itself. A registration that completes during an exchange aborts it (906) and goes on without the account. A client that is logged in gets `ERR_SASLALREADY` (907): an account can not change on a connection, so there is no logout either. A connection is disconnected after its third failure, with the reason. Without a database, `sasl` and `draft/account-registration` are not advertised, and are refused.
- A client that is logged in is shown with `ACCOUNT` to itself and to the others with `account-notify` (and to those that monitor it with `extended-monitor`), with the `account` tag (`account-tag`) on every message from it, in the extended `JOIN`, in WHOX (`a`), and with `RPL_WHOISACCOUNT` (330) in `WHOIS`. The `ACCOUNT` of a login is sent before the account is set, so it does not have the tag, as in the example of account-tag.
- The name of an account is reserved as a nickname for the clients logged in to it (`reserveNicknames`, on by default). `NICK` gets `ERR_NICKNAMEINUSE` (433) with `Nickname is reserved by a different account`, which clients handle as for a nickname in use. Before the registration, the check is done when the registration completes, as a client sends `NICK` before it logs in with SASL; the registration stops with the same 433, the nickname is released, and the client sends another one.
- The passwords are hashed with PBKDF2-HMAC-SHA-256 of WebCrypto, which both runtimes have, with a random salt of 16 bytes and 100,000 iterations, the most that Cloudflare Workers allows (`iterations`). The algorithm, the iterations, and the salt are stored with the hash, so the parameters can change. A password is never stored or logged; the hashes are compared in constant time.
- The hash is asynchronous, and the handlers are synchronous: it is the prepare step of `AUTHENTICATE` and `REGISTER` (see [How it works](#how-it-works)). It runs only for a well-formed response to an existing account, or for a `REGISTER` that would succeed, and the handler reads the account again afterwards. A connection that closes meanwhile is left alone.
- Limits, in `accounts` of `createServer()`: `registration` (`open`, or `closed`), `maxAccounts` (100,000), `maxPerAddress` (5 accounts from one address within `registrationWindow`, an hour), `maxFailures` (3 SASL failures on a connection), `throttle` (10 hashes at once for an address, and one more every 6 seconds), `minPasswordLength` (8), `maxPasswordLength` (300), and `reserveNicknames`. An address is an IPv4 address or an IPv6 /64, and the clients whose address is unknown count as one. It is stored as its cloak, a keyed hash, and only for the window.
- The accounts are no secret, as their names are reserved, so a SASL attempt for a name that is not an account fails without a hash, faster.

### Storage

`src/store.ts` is a small synchronous SQL interface, `query(sql, ...params)` and `transaction(fn)`, with two implementations of SQLite, so the tests on Node.js run the queries of production:

- On Cloudflare Workers, the SQLite database of the Durable Object, with `ctx.storage.sql.exec()` and `ctx.storage.transactionSync()`. It is in the storage of the object, so the accounts survive restarts and deploys. Under `cf dev`, it is in `.cloudflare/state`.
- On Node.js, `node:sqlite` (`DatabaseSync`), in the file of `DATABASE`, or in memory without it. `createServer()` without `database` uses an in-memory database where the runtime has `node:sqlite`, which is loaded with `process.getBuiltinModule()`, so the bundle of the Worker does not import it.

The schema is a list of migrations, each applied once in a transaction, at startup. A database whose schema is newer than the server is refused. The writes of an account are one transaction. Migration 2 adds the permanent channels, the history, and the read markers. Migration 3 adds the size of each message (counted for the rows already stored), the index of the sizes, the boundary of the history of a permanent channel (`since`), and the index of `LIST`.

A failure of the database never stops the server, nor leaves the clients and the memory apart: a write that the state depends on, such as making a channel permanent or registering an account, is done before the state changes, and its failure is told to the client (`ERR_UNKNOWNERROR` for `MODE +P`, `TEMPORARILY_UNAVAILABLE` for `REGISTER`, `INTERNAL_ERROR` for `MARKREAD`); one that it does not, such as storing a message or the state of a permanent channel after a change, is skipped, and the server goes on from memory: the message is delivered, the change is made and told, and a `JOIN` completes. The failures are logged once a minute at most, with the number of the others (`Server.safely()`).

## History and permanent channels

With a database, a channel and its messages outlive the moment everyone is offline, so a client that comes back, such as one on a phone, gets what it missed. Without one (`database: false`), there is no `P` mode, `draft/chathistory` and `draft/read-marker` are not advertised, `CHATHISTORY` and `MARKREAD` are unknown commands, and nothing is stored.

### Permanent channels

- A channel that a client logged in to an account creates records that account as its founder, and is permanent (`+P`) unless `persistChannels` is off, or the founder already has `permanentChannels.maxPerAccount` (20) permanent channels, or the server `maxChannels` (10,000). It is then an ordinary channel, with its founder, which can set `+P` later. Only the founder, logged in and in the channel, sets or clears `P`: another member gets `ERR_CHANOPRIVSNEEDED` (482), the founder outside the channel `ERR_NOTONCHANNEL` (442), and a founder over a limit `ERR_TOOMANYCHANNELS` (405).
- What is stored: the name as it was created, the creation time, the founder (the folded name of its account), the topic with who set it and when, the modes of type D, the key, the limit, and the lists `b`, `e`, and `I` with who set each mask and when. A `MODE` or `TOPIC` that changes any of it updates the row in the same request, in one statement. The members, the operators and voices, and the invites are not stored.
- When the last member leaves, the row stays, and the channel object goes from memory. The next `JOIN` restores it as it was, and its key, limit, bans, and `+i` apply. The founder, logged in to its account, gets `o` whenever it joins; nobody else gets `o` for arriving first. Another member can be given `o` as usual.
- `-P` makes it an ordinary channel and deletes its row at once, in the same transaction that lets its history go with the channel. This differs from the decision "deletes the stored row once empty" only in when, and no stale row can survive a restart.
- A permanent channel that nobody has joined for `permanentChannels.expire` (90 days) is purged with its history by `tick()`, ten at a time.
- An empty permanent channel shows in `LIST` with 0 users, and `TOPIC` and `MODE` (with the lists) answer for it as for a channel that nobody can see from inside, unless it is secret (`+s`): then it is not listed, and those get `ERR_NOSUCHCHANNEL`. `NAMES` and `WHOIS` show no members, as it has none.

### draft/chathistory

[`CHATHISTORY`](https://ircv3.net/specs/extensions/chathistory) with `LATEST`, `BEFORE`, `AFTER`, `AROUND`, `BETWEEN`, and `TARGETS`, `CHATHISTORY=100` (`history.limit`), and `MSGREFTYPES=msgid,timestamp`.

- A message is a row of the table `history`, written by `deliver()` once it is allowed (after `canSend()`), before it is sent, in the request: every `PRIVMSG` and `NOTICE`, and a multiline message as one row, with its msgid, the time of the msgid, the mask of the sender at the time, its account, its bot mode, the target as the recipients got it, the text or the lines, and the client-only tags. `TAGMSG` is not stored. If the database fails, the message is delivered anyway.
- The msgids sort by time (`Server.msgid()`), and the `time` tag of a message is the time of its msgid, so the order of the history is the order of the msgids, and every query is a range of the index `(target, msgid)`. A `timestamp=` reference is turned into a bound of msgids, and a `msgid=` reference is a position in that order whether the message is still stored or not. The bounds are exclusive; `AROUND` gives half the limit before the reference and the rest from it on, the message itself included. `TARGETS` takes timestamps only.
- The reply is a `chathistory` batch for a client with `batch`, with `draft/chathistory-end` on the first line when there is nothing more in that direction, and plain lines otherwise. A reply has at most `limit` messages and stops at about 256 KiB, after one message at least. Each message is sent by `present()`, as when it was delivered: its original `time` and `msgid`, the `account` and `bot` tags of the sender as they were then (not as they are now), the client-only tags for a client with `message-tags`, and a multiline message as a `draft/multiline` batch nested in the `chathistory` one, or as its lines without the blank ones, with the msgid on the first. Playing back changes nothing: nothing is stored, marked as read, echoed, or answered with `RPL_AWAY`.
- Every `FAIL` code of the spec: `INVALID_PARAMS` (unknown subcommand, missing or extra parameters, a reference or a limit that does not parse, `*` other than for `LATEST`, a msgid for `TARGETS`), `INVALID_MSGREFTYPE` (a reference type other than `msgid` and `timestamp`), `INVALID_TARGET`, and `MESSAGE_ERROR` when the database fails.
- The client need not have negotiated `draft/chathistory` to use the command; the capability tells the server not to send history by itself (`replayOnJoin`).
- `draft/event-playback` is not implemented. The table could hold the events, but `QUIT` and `NICK` would write a row for each channel of the user, a reconnecting phone `JOIN` and `QUIT` in each of its channels, and typing notifications would be most of the `TAGMSG`s, all sharing the limit of each target with the messages, or needing a second index to page the messages alone.

#### Who reads what

- A channel's history is for its current members only. A member that is banned and has neither `o` nor `v` gets `INVALID_TARGET`, as does a client outside the channel, and anyone for a channel that is not in memory. A member reads the whole history of a permanent channel, and the history of an ordinary channel from when it joined. An ordinary channel's history is deleted when the channel ends (a little at a time by `tick()`; a new channel of the same name starts empty), and at a restart.
- A direct message is stored only when both the sender and the recipient are logged in to accounts, by the pair of accounts, not by the nicknames: either account reads the conversation from any connection, after a change of nickname, or when the other is offline. A nickname as the target stands for the account of the client that has it, or else for the account of that name. A client that is not logged in has no direct history. The messages are played back as they were sent, with the nicknames of the time.
- `TARGETS` lists the channels the client is in that it may read, and the accounts it has direct messages with (by the names of the accounts), by the time of their last message.

#### Retention

Set with `history` of `createServer()`, and enforced a little at a time, so that no request does unbounded work:

- `maxMessages` (10,000): the newest messages of each target. Each new message deletes the oldest of its target over the limit (at most 3 at a time, if the limit was lowered).
- `maxAge` (90 days): each new message deletes up to 2 messages of its target that are older, and `tick()` up to 1,000 of the oldest of the server.
- `maxRows` (2,000,000): the server keeps at most the last `maxRows` messages it stored; each new message deletes up to 2 that are older than that.
- `maxTargetBytes` (16 MiB) and `maxBytes` (1 GiB): the bytes of the messages of each target, and of the server, as the column `size` of each row counts them (its text columns, its msgid three times, for the row and the two indexes, and 64 bytes for the rest). Each new message deletes the oldest of its target, or of the server, until they are back under the budget, at most 512 rows; so a message always frees at least its own size, as no row has more than about 30 KB. The oldest of a target are found with their sizes in the index `(target, msgid, size)`, without reading the rows, and those of the server one, then two, then four rows at a time, so a few more than it takes may go.
- `maxStoredTags` (1,024): the client-only tags of a message are stored as on a line, `+a=1;+b`, only if they take at most this many bytes. They are relayed whole, and a message that is played back has no client-only tags if they did not fit.
- `maxMarkers` (200): the read markers of an account.
- The counts and the bytes of the messages of a target are read once from the index of the sizes, as are the bytes of the whole server when it first stores a message, and then kept in memory.

#### What is stored about the users

The mask (`nick!user@cloak`, never the address) and the account of the sender of each stored message, and its bot mode, for as long as the message is kept; the founder of each permanent channel, and who set its topic and each mask of its lists, as IRC shows them; the read markers of each account. A direct message between two accounts is readable by both. Nothing is stored for a client that is not logged in, but the messages that it sends to channels.

#### The cost

One message is one row of `history` and one entry in each of its two indexes, `(target, msgid)` and `(target, msgid, size)`: 3 rows written on a Durable Object, plus about as many to delete when a budget is full. The first message of a channel or of a pair of accounts also writes a row of `targets`. A message of one line takes at most about 1.8 KB (510 bytes of text, 1,024 of tags, the mask, and the msgid), and a multiline message at the largest size that the capability advertises (4,096 bytes in 100 lines) at most about 30 KB, with JSON that takes 6 bytes for a control character: far below the limit of 2 MB of a row.

The largest database, in the worst case, with the default limits, is well under the 10 GB of a Durable Object:

- The history: at most `maxBytes`, 1 GiB, as `size` counts it, which a database file measured at 1.05 to 1.26 times that, with rows of all sizes. Say 1.5 GiB. `maxRows` alone would not bound it: 2,000,000 rows of 30 KB are 60 GB.
- The read markers: `maxAccounts` × `maxMarkers` rows of about 100 bytes (two names and a time), 100,000 × 200 × 100 B = 2 GB.
- The permanent channels: 10,000 rows with lists of 100 masks of 100 bytes, with who set them, about 25 KB each, 250 MB.
- The accounts: 100,000 rows of about 200 bytes, 20 MB, and the registrations of the last hour, fewer.
- About 4 GB in all. A client without an account writes only the messages to channels, which `maxBytes` bounds, so the rest needs accounts, which `maxPerAddress` and `maxAccounts` limit.

### draft/read-marker

[`MARKREAD`](https://ircv3.net/specs/extensions/read-marker): a marker belongs to an account, for a channel that exists or for the direct messages with another account, is stored as one row, only moves forward (not past the time of the server), and is sent to the other connections of the account with the capability when it moves, and on `JOIN`, before `RPL_ENDOFNAMES`. A client that is not logged in gets `*`, and setting a marker fails with `INTERNAL_ERROR`. An account has at most `history.maxMarkers` (200) markers. A secret channel that the client is not in is answered as one that does not exist. The errors are `NEED_MORE_PARAMS`, `INVALID_PARAMS`, and `INTERNAL_ERROR`.

### replayOnJoin

`replayOnJoin` (0, off): a client without `draft/chathistory` gets the last N messages that it may read (so, in practice, those of a permanent channel) when it joins, in a `chathistory` batch if it has `batch`, before the names.

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

## Memory

A Durable Object has 128 MB of memory, which all the connections share. What a connection holds, beyond its state, is what waits to be sent to it:

- The messages pushed to it, up to `maxBufferedBytes` (1 MiB), which `createServer()` gives to tcp-hono for TCP, and to `fromWebSocket()` for a WebSocket. A client that does not read is disconnected beyond it.
- The response to its command, which is written whole and waits for the client to read it, outside `maxBufferedBytes`. So it is bounded by `maxReplyBytes` (512 KiB): a longer one is not sent, and the client gets `ERROR :Closing Link: <host> (Reply too long)` and is disconnected, as it is a bug or abuse. The largest replies are bounded below it: `LIST` by `maxListEntries` (500 entries of at most about 450 bytes, 225 KB), a `CHATHISTORY` reply at about 256 KiB, and `WHO` of a channel by its members.

So one address, as `maxConnectionsPerIp` counts it, holds at most 10 × (1 MiB + 512 KiB) = 15 MiB, and one IPv6 /48 at most 20 × 1.5 MiB = 30 MiB: a 128 MB object survives one of them. Measured on Node.js, 50 TCP clients that send `LIST` (500 entries, 213 KB) and never read add 12 MB to the heap after a garbage collection (and 81 MB to the RSS), where 10,000 permanent channels, before `maxListEntries`, added 709 MB.

What remains: `maxConnections` (1,000) × 1.5 MiB is 1.5 GiB, so many addresses together can still exhaust the object. Lower limits shrink it (`maxBufferedBytes` and `maxReplyBytes` of 256 KiB make it 500 MB), but only a budget of the bytes waiting for all the connections together bounds it, and that needs tcp-hono to expose how many bytes a connection has queued (`bufferedBytes`), which it does not yet. That is future work.

## Deploying

This has only been run locally. In production, a [Spectrum application with a Worker origin](https://developers.cloudflare.com/spectrum/how-to/route-tcp-traffic-to-a-worker/) routes a TCP port of a hostname to the `connect()` handler. It needs a paid zone. The WebSocket transport needs only the Worker, on workers.dev or a custom domain.

## Development

```sh
pnpm test        # vp test
pnpm check       # vp check: format, lint, and type check
pnpm typecheck   # with the types of Cloudflare Workers
PORT=6701 pnpm dev:node & pnpm e2e 127.0.0.1 6701   # a smoke test with irc-framework
pnpm dev & pnpm e2e 127.0.0.1 6667                   # the same under cf dev
```

Node.js 24 or later is required.
