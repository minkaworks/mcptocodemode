# Protocol comparison

Measured on 23 October 2026, Node v26.12.1, macOS, with the code in the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md), after 0.2.1. The model section is older and says which build it ran. No model was in the loop. A script drove the same eight upstream calls through two hosts, so the numbers are about bytes and time, not about whether a model writes good code.

The servers are the reference implementations in [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers), pinned in `mcptocodemode.reference.example.json`: everything, filesystem, memory, sequential thinking, time, git, and fetch. All seven connected. Together they expose 55 tools. Raw output is `experiments/reference-servers.json`. Repeat with `pnpm build && pnpm measure`.

Three shapes:

| Protocol | What sits in the prompt |
| --- | --- |
| Flat MCP | One tool definition per upstream tool |
| Inline SDK | One code tool, plus the generated TypeScript for every method. This is the shape of Cloudflare's small-catalog Code Mode. It is not a run of their Workers product. |
| Progressive Code Mode | `search`, `describe`, and `execute` only. Schemas stay out until something asks. |

## Prompt

UTF-8 bytes of `{ name, description, inputSchema }` for each tool. Dividing by 4 is a rough token stand-in, not a tokenizer.

| Protocol | Tools in the prompt | Bytes | ÷ 4 |
| --- | ---: | ---: | ---: |
| Flat MCP | 55 | 31,179 | ~7,800 |
| Inline SDK | 1 | 34,632 | ~8,700 |
| Progressive Code Mode | 3 | 2,996 | ~750 |

The inline figure is 33,028 bytes of generated TypeScript plus the 1,604-byte `execute` tool. That is more than the flat catalog (34,632 against 31,179) since signatures carry each method's return type from its `outputSchema`, which flat MCP leaves out. It grows with every new method. The three Code Mode tools do not. Their 2,996 bytes are mostly the `execute` description, which explains `state` and handles with a short example.

The largest flat definitions were `sequentialthinking` (4,060 bytes), `everything__gzip-file-as-resource` (1,107), and `fetch` (1,052).

## Growth

The same catalog, adding one server at a time in config order.

| Servers | Added | Tools | Flat MCP | Inline SDK | Progressive Code Mode |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | everything | 16 | 7,298 | 8,129 | 2,996 |
| 2 | filesystem | 30 | 15,508 | 14,794 | 2,996 |
| 3 | memory | 39 | 20,037 | 21,759 | 2,996 |
| 4 | sequential-thinking | 40 | 24,097 | 24,727 | 2,996 |
| 5 | time | 42 | 25,284 | 27,570 | 2,996 |
| 6 | git | 54 | 30,127 | 32,067 | 2,996 |
| 7 | fetch | 55 | 31,179 | 34,511 | 2,996 |

Bytes in the prompt. The Code Mode column is the three tool definitions and does not depend on the catalog. Flat MCP averages about 570 bytes per tool here. One server with a few large schemas moves it more than several small ones: `sequential-thinking` is one tool and 4,060 bytes. With a single server, Code Mode is already two fifths of flat MCP (2,996 against 7,298). That gap only widens.

## Discovery

Progressive Code Mode pays for schemas only when asked.

| Ask | Bytes |
| --- | ---: |
| `search` with an empty query, 8 hits | 2,030 |
| `describe` of the 8 methods this task calls | 6,108 |
| `describe` of all 7 servers | 32,907 |

Describing every server costs about the same as pasting the whole SDK (32,907 against 33,028). The saving is describing the methods you are about to call, or searching.

## One task

Eight calls, the same arguments on both sides: current time in `America/Mexico_City`, read one file, `git_log`, one thinking step, create a memory entity, read the graph, fetch the servers README, and `echo`. Fetch used the server's own length limit. The Code Mode program returned only the fields the task needed. The fetched page stayed in the sandbox.

| | Flat MCP | Code Mode |
| --- | ---: | ---: |
| Bytes returned to the caller | 5,812 | 827 |
| Of which the answer itself | 5,812 | 286 |
| Upstream calls | 8 | 8, inside one `execute` |

Fetch is 5,223 of the 5,812 flat bytes. The other seven results sum to 589 bytes. On a task whose results are already small, the Code Mode envelope (the answer plus the call trace) can be larger than those small results. The payload win shows up when a result is big and the program does not return it.

If each flat result stays in the conversation, later turns re-read the earlier ones. The prefix sums of those eight results add up to 13,562 bytes seen across the turns, against one 827-byte `execute` result. A prompt cache would not remove that growth. It would only change how often the 31,179-byte catalog is billed. This run did not measure a cache.

## A large result

`scripts/measure.mjs` writes a deterministic 2,000-line log with an `ERROR` line every 97 lines. The task: how many errors, and the last three.

| | Flat MCP | Code Mode |
| --- | ---: | ---: |
| Turns | 1 | 1 |
| Bytes returned to the caller | 129,977 | 402 |
| Of which the answer itself | 129,977 | 294 |
| Code the model writes | none | 251 |

Flat MCP hands the model the whole file and asks it to count 20 lines among 2,000 by reading. The program counts them, and returns `{ count: 20, last: [...] }`. That is 323 times fewer bytes. The file stays in the sandbox. The answer is exact because code computed it, not a model reading 130 KB.

The default `maxResultChars` is 200,000, so the flat path was not truncated here. A file past that limit would reach the flat caller as a 4,000-character preview and the count would be wrong. The program sees the same cap per call, so a bigger file would need paging on both sides.

## Fan-out

25 order files, each a small JSON document. The task: list the directory, read every order, and total the paid ones.

| | Flat MCP, one call per turn | Code Mode |
| --- | ---: | ---: |
| Turns | 26 | 1 |
| Upstream calls | 26 | 26, inside one `execute` |
| Bytes of results | 12,699 | 217 |
| Re-read across later turns | 172,698 | 217 |
| Answer | | `{ orders: 25, paid: 19, total: 1906.81 }` |

The results are small one by one. The cost is the loop. Each turn re-reads every result before it, so 12,699 bytes of results become 172,698 bytes of context read across 26 turns. The program reads all 25 files with `Promise.all` and returns 39 bytes of answer plus the call trace. A run where every call succeeded reports one trace entry per method with a count, so the 26 calls take two entries and the envelope is 217 bytes. With one entry per call, as before, it was 1,822.

A client that issues parallel tool calls can do the flat version in 2 turns: list, then 25 reads at once. That removes most of the re-reading. It still puts all 12,699 bytes in the conversation, and the model still adds up 19 totals by hand.

## Time

Three runs each. Fetch is about nine tenths of the wall clock on both sides.

| | Min | Median | Max |
| --- | ---: | ---: | ---: |
| Eight direct calls | 1,630 ms | 1,721 ms | 2,786 ms |
| One `execute` | 1,685 ms | 2,040 ms | 2,491 ms |

The gap is inside the noise of one network fetch, which is most of either column. Code Mode does not make upstream calls faster. The upstream calls dominate, and the sandbox adds well under a millisecond per run. The local tasks above took 5 to 32 ms either way.

No model was in the loop, so none of these times include model turns. In practice a turn costs seconds. The 26-turn fan-out is where that difference would show.

## Startup

An MCP client launches the server and waits for the handshake before it can call anything. `scripts/measure.mjs` launches `serve` over stdio against the seven servers, times the handshake and the first `search` from launch, then waits two seconds for a model turn and times the first `execute` that calls `time`. Three runs each, launches four seconds apart so the previous run's upstream processes have exited.

| | Handshake | First `search` | First `execute`, after the turn |
| --- | ---: | ---: | ---: |
| 0.1.1 | 1,680 ms | 1,697 ms | 41 ms |
| Empty tool cache | 301 ms | 1,796 ms | 37 ms |
| Cached tool lists | 306 ms | 320 ms | 36 ms |
| Cached, `--lazy` | 288 ms | 300 ms | 614 ms |

Medians. 0.1.1 connected to every server before it answered the handshake. Now the handshake comes back in about 300 ms, mostly Node starting. With an empty cache the first `search` still waits for the seven servers, about as long as 0.1.1 took. That run writes the cache.

With cached tool lists the first `search` answers in about 320 ms, 5.3 times sooner, and no server has to be up for it. The servers connect in the background meanwhile. The model's turn hides that launch, so the first `execute` finds `time` already connected. `--lazy` skips the background launch: an unused server never starts, and the first call to a server pays for its launch, here about 580 ms for `uvx`.

The 0.1.1 row was measured earlier the same day with the same script against a build of the `v0.1.1` tag (`git worktree add ../v011 v0.1.1`).

## Turns

| Path | Turns for this task |
| --- | --- |
| Flat MCP | 8, one per call |
| Inline SDK | 1 |
| Progressive, methods already known | 1 |
| Progressive, lookup outside the sandbox | 10: one search, eight describes, one execute |
| Progressive, one search per method, signatures in the hits | 9: eight searches, one execute |

`codemode.search` and `codemode.describe` run inside `execute`, so the lookup does not have to be ten turns.

The first three hits of a search now carry their TypeScript signature. For five queries against this catalog (`current time timezone`, `read file`, `git log`, `create entities memory`, `fetch url`) the first hit was the method the query was after every time, and the signatures added 550 to 980 bytes to a response of 1,500 to 2,800. A `describe` of one of the eight methods above averages 890 bytes and costs a turn. Whether a model then skips that turn is a question for a run with a model in it.

## Mail

`scripts/measure-mail.mjs` runs an in-process mail server, not Gmail, with deterministic data: 30 threads in three pages of 10 with 600-character snippets, 8,000-character message bodies, and a 150,000-byte PNG attachment. The task: count the unread threads across every page, then read the first unread thread with an attachment, download the attachment, and pass it to `index_attachment`. Plain MCP makes the six calls one by one and hands the model each result's content blocks. Code Mode runs one `execute` that pages, counts, and passes the image on as a handle.

| | Plain MCP | Code Mode |
| --- | ---: | ---: |
| Turns | 6 | 1 |
| Bytes of results back to the model | 230,668 | 362 |
| Bytes the model writes as arguments | 200,141 | 582 of code |
| Re-read across later turns | 737,121 | 362 |
| Base64 or message bodies in what comes back | yes | no |
| Answer | | `{ unread: 10, thread: "t21", indexed: { bytes: 150000, mimeType: "image/png" } }` |

| Plain MCP call | Arguments | Result |
| --- | ---: | ---: |
| `search_threads`, page 1 | 20 | 7,458 |
| `search_threads`, page 2 | 41 | 7,467 |
| `search_threads`, page 3 | 41 | 7,436 |
| `get_message` | 12 | 8,184 |
| `get_attachment` | 16 | 200,051 |
| `index_attachment` | 200,011 | 72 |

The image dominates. In plain MCP its 200,051 bytes of base64 come back to the model, and the model then has to write the same bytes out again as `index_attachment`'s argument, which costs output tokens as well as input. In Code Mode `get_attachment` returns `{ $handle, type, mimeType }`, the host swaps the handle for the base64 when `index_attachment` is called, and the bytes never enter the sandbox or the reply. The 362-byte envelope is the answer and a trace of four methods. It was checked to contain neither the base64 nor a message body, and the answer matches the fixture.

The same task is in `scripts/bench-model.mjs` as `BENCH_TASKS=mail`. It has not been run with a model.

## With a model

`scripts/bench-model.mjs` gives the same model the same tasks twice. Plain MCP exposes every tool directly as a function: the 55 reference tools plus the 4 of the mail fixture, 34,269 bytes of definitions. MCPtoCodeMode exposes `search`, `describe`, and `execute` through the real MCP server, 3,090 bytes, with the session, `state`, handles, and the summed trace of this build. Each run starts from an empty session. Each answer is checked against its fixture. Tokens and cost are what OpenRouter reported. Temperature 0, medians. 23 October 2026.

- **log**: count the `ERROR` lines in the 2,000-line log and give the last job number.
- **orders**: count the paid orders among 25 files and total them.
- **mixed**: the latest commit subject from git and the text of a file from filesystem.
- **mail**: the task from the [Mail](#mail) section: count unread threads across three pages, then download the first unread attachment and pass it to `index_attachment`.

Three runs per cell for the first three tasks:

| Model | Task | Plain: tokens in | Code Mode: tokens in | Plain: turns | Code Mode: turns | Plain: cost | Code Mode: cost |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Claude Sonnet 5.5 | log | 102,282 | 8,197 | 2 | 3 | $0.207 | $0.019 |
| Claude Sonnet 5.5 | orders | 48,432 | 13,365 | 3 | 4 | $0.108 | $0.033 |
| Claude Sonnet 5.5 | mixed | 26,446 | 11,323 | 2 | 3 | $0.055 | $0.025 |
| Claude Haiku 5.5 | log | 102,282 | 8,383 | 2 | 3 | $0.011 | $0.001 |
| Claude Haiku 5.5 | orders | 48,432 | 20,133 | 3 | 4 | $0.006 | $0.003 |
| Claude Haiku 5.5 | mixed | 26,446 | 11,331 | 2 | 3 | $0.003 | $0.001 |

Across those 18 runs per model:

| | Plain MCP | MCPtoCodeMode |
| --- | ---: | ---: |
| Correct answers, Sonnet | 9 / 9 | 9 / 9 |
| Correct answers, Haiku | 9 / 9 | 9 / 9 |
| Input tokens, Sonnet | 531,480 | 94,002 (5.7× fewer) |
| Input tokens, Haiku | 531,480 | 146,323 (3.6× fewer) |
| Cost, Sonnet | $1.108 | $0.222 (5.0× less) |
| Turns, Sonnet | 21 | 29 |

Both arms answered every one of these tasks correctly, so here the difference is cost, not accuracy. Plain MCP needed fewer turns. The models called tools in parallel: the 25 order files went out in one turn, not 25, which the byte-level fan-out above does not assume. MCPtoCodeMode usually spent one extra turn on `search`, and sometimes one on fixing a program. Wall clock came out about even, within a second or two either way per task. These numbers are within a few percent of a run on the previous build, which had no session and a fresh isolate per `execute`, so the session did not change cost or turns on tasks that fit in one program.

One run per cell for mail, because a plain run costs up to $0.76:

| Model | Arm | Correct | Turns | Tokens in | Tokens out | Cost | Time |
| --- | --- | :---: | ---: | ---: | ---: | ---: | ---: |
| Claude Sonnet 5.5 | Plain MCP | no | 6 | 307,882 | 14,002 | $0.756 | 79 s |
| Claude Sonnet 5.5 | MCPtoCodeMode | yes | 5 | 27,536 | 600 | $0.061 | 10 s |
| Claude Haiku 5.5 | Plain MCP | no | 7 | 521,815 | 131,631 | $0.551 | 381 s |
| Claude Haiku 5.5 | MCPtoCodeMode | yes | 6 | 20,019 | 849 | $0.002 | 8 s |

Neither model finished the mail task through plain MCP. Both paged and counted correctly, read the message, and downloaded the image, which put 200,051 bytes of base64 in the conversation. Then the image had to go back out as `index_attachment`'s argument. Haiku spent 131,631 output tokens and six minutes on it and sent `{}`, which the server rejected. Sonnet did not try: it answered with `bytes: null`. Through MCPtoCodeMode both got the right answer. `get_attachment` returned a handle, and Sonnet kept it in `state` between two runs and passed it to `index_attachment` in the second. The bytes never reached the model.

The log task is where output types matter. Before signatures carried `outputSchema`, `filesystem.read_text_file` read as `Promise<unknown>`. Haiku returned the whole file from `execute` to see its shape, then misread the `{ ok, result }` envelope: 5 turns and 242,886 input tokens, more than plain MCP. With `Promise<{ content: string }>` in the signature it filters in the sandbox on the first try.

Raw results, with a per-turn trace of every tool call, are in `experiments/model-bench.json`. Repeat with `OPENROUTER_API_KEY=... pnpm build && pnpm bench:model`; `BENCH_TASKS` picks tasks, `BENCH_RUNS` sets the runs, and `BENCH_MAX_RUN_COST` (default $1) stops a run that spends more. This run cost $2.77.

## What this does not say

Outside the model section, bytes are not tokens and dividing by 4 is a stand-in. The model section covers three small tasks and two models. It does not say how either arm does on long, open-ended work. It does not compare stdio, streamable HTTP, and SSE. It does not price a provider's prompt cache. One catalog, one machine, one afternoon.
