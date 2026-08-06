# Implementation review

*   **Subprocess execution is fragile**: Poll loops run collectors sequentially without subprocess timeouts; a single hung tool (e.g., `tmux`) permanently freezes the entire server's collection loop.
*   **Transient failures are permanent**: Both `git` and `tmux` collectors disable themselves permanently on any shell error (e.g., a momentary file lock), halting future updates for the session.
*   **Edge cases in parsing and streams**: Git porcelain parsing ignores shell quoting for paths with spaces, tmux crashes on tab characters, and the SSE stream can permanently leak coroutines if a client disconnects during backpressure.

### 1. Poll loop hangs forever on subprocess stall
`packages/server/src/server/exec.ts:13`
`packages/server/src/collectors/tmux/collector.ts:84`
`packages/server/src/server/poll-loop.ts:71`

*What breaks*: The real `execFile` implementation does not enforce a default timeout. `tmuxCollector` shells out to `capture-pane` for every pane sequentially without passing `timeoutMs`.
*Concrete failure scenario*: If the `tmux` daemon hangs or a command blocks on I/O, `execFile` never returns. Because `poll-loop.ts` loops over collectors sequentially with `await collector.poll()`, one hung subprocess permanently freezes all collectors (git, sessionlog, workmux). `inFlightTick` never resolves, stopping the 2-second heartbeat forever.

### 2. Transient collector failures are permanent
`packages/server/src/collectors/git/git-collector.ts:58`
`packages/server/src/collectors/tmux/collector.ts:63`

*What breaks*: When the initial probing command (`git worktree list --porcelain` or `tmux list-panes`) fails, the collectors return `{ ...prevSnapshot, disabled: true }`. The `poll()` method bypasses all future polls if `prevSnapshot.disabled` is true.
*Concrete failure scenario*: A momentary `.git/index.lock` conflict, high system load, or a transient `tmux` socket error causes a non-zero exit code. The collector permanently disables itself for the remainder of the Node process lifecycle, requiring a server restart to resume tracking.

### 3. Client disconnect during stream backpressure leaks coroutines
`packages/server/src/api/stream.ts:49`
`packages/server/src/api/stream.ts:71`

*What breaks*: `flushBacklog` streams events in chunks. If the node socket buffer fills, `writeEvent` returns `false` and the loop awaits `onceDrained(sink)`, which sets a `sink.once('drain', ...)` listener.
*Concrete failure scenario*: A slow client requests a large session stream, triggering backpressure. While the server is paused at `await onceDrained(sink)`, the client abruptly disconnects or closes the tab. The socket closes, but the `drain` event will never fire. The `onceDrained` promise hangs indefinitely, leaking the `flushBacklog` coroutine.

### 4. Git status parser breaks on spaces/unicode in paths
`packages/server/src/collectors/git/parse-status.ts:16`

*What breaks*: `parseStatusLine` strips the first 3 characters and assumes the rest of the string is the raw path. However, `git status --porcelain` (unlike `-z`) surrounds paths in double quotes and escapes characters if the path contains spaces or non-ASCII characters.
*Concrete failure scenario*: A user creates a file named `hello world.txt`. Git outputs `A  "hello world.txt"`. The parsed `path` becomes `"hello world.txt"` (including the literal quotes). This breaks downstream file matching, diffing, and collision checks.

### 5. Tmux tab delimiter assumption crashes pane parsing
`packages/server/src/collectors/tmux/list-panes.ts:30`

*What breaks*: `parseListPanesLine` splits the `-F` format by `\t` and strictly asserts `if (fields.length !== FIELD_COUNT) throw new Error(...)`. `tmux` does not sanitize escape sequences or tab characters in pane titles or running commands.
*Concrete failure scenario*: A user runs a script with a tab in the name, or changes a pane title dynamically to include a tab (`printf "\033]2;with\ttab\033\\"`). The split yields too many fields, throwing an exception. The exception aborts the entire `list-panes` parsing sequence, stopping all pane updates on the server until the offending pane is closed.

### 6. Batched stream flushes queued events without respecting backpressure
`packages/server/src/api/stream.ts:114`

*What breaks*: In `streamBacklogThenLive`, events that arrive while `flushBacklog` is running are queued. Once the backlog finishes, the queue is drained with a synchronous loop calling `writeEvent(sink, event)`.
*Concrete failure scenario*: If the backlog took 5 seconds to flush and the queue accumulated thousands of events, draining them in a single synchronous block ignores the `writeEvent` return value. It dumps everything into the socket buffer at once, spiking memory and bypassing the backpressure protection that `flushBacklog` was designed to provide.

### 7. File I/O overhead in event recorder limits scale
`packages/server/src/recorder/session-log-writer.ts:60`

*What breaks*: `SessionLogWriter.append()` uses `appendFile` to log every incoming event. `appendFile` performs a full `open()`, `write()`, and `close()` syscall cycle for every single call.
*Concrete failure scenario*: In a high-throughput session where an LLM streams text quickly (emitting many usage or tool activity ticks per second), the constant file handle thrashing causes heavy CPU and filesystem I/O spikes, potentially starving the Node event loop and slowing down the collector polling intervals.
