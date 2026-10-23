# Protocol comparison

Measured on 22 October 2026, Node v26.12.1, macOS, with MCPtoCodeMode 0.2.0. No model was in the loop. A script drove the same eight upstream calls through two hosts, so the numbers are about bytes and time, not about whether a model writes good code.

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
| Inline SDK | 1 | 23,176 | ~5,800 |
| Progressive Code Mode | 3 | 2,581 | ~650 |

The inline figure is 22,149 bytes of generated TypeScript plus the 1,027-byte `execute` tool. At 55 tools it is already about three quarters of the flat catalog (23,176 / 31,179). It grows with every new method. The three Code Mode tools do not.

The largest flat definitions were `sequentialthinking` (4,060 bytes), `everything__gzip-file-as-resource` (1,107), and `fetch` (1,052).

## Growth

The same catalog, adding one server at a time in config order.

| Servers | Added | Tools | Flat MCP | Inline SDK | Progressive Code Mode |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | everything | 16 | 7,298 | 6,171 | 2,581 |
| 2 | filesystem | 30 | 15,508 | 11,242 | 2,581 |
| 3 | memory | 39 | 20,037 | 14,788 | 2,581 |
| 4 | sequential-thinking | 40 | 24,097 | 16,563 | 2,581 |
| 5 | time | 42 | 25,284 | 18,192 | 2,581 |
| 6 | git | 54 | 30,127 | 21,650 | 2,581 |
| 7 | fetch | 55 | 31,179 | 23,055 | 2,581 |

Bytes in the prompt. The Code Mode column is the three tool definitions and does not depend on the catalog. Flat MCP averages about 570 bytes per tool here. One server with a few large schemas moves it more than several small ones: `sequential-thinking` is one tool and 4,060 bytes. With a single server, Code Mode is already a third of flat MCP. That gap only widens.

## Discovery

Progressive Code Mode pays for schemas only when asked.

| Ask | Bytes |
| --- | ---: |
| `search` with an empty query, 8 hits | 2,030 |
| `describe` of the 8 methods this task calls | 6,108 |
| `describe` of all 7 servers | 22,028 |

Describing every server costs about the same as pasting the whole SDK (22,028 against 22,149). The saving is describing the methods you are about to call, or searching.

## One task

Eight calls, the same arguments on both sides: current time in `America/Mexico_City`, read one file, `git_log`, one thinking step, create a memory entity, read the graph, fetch the servers README, and `echo`. Fetch used the server's own length limit. The Code Mode program returned only the fields the task needed. The fetched page stayed in the sandbox.

| | Flat MCP | Code Mode |
| --- | ---: | ---: |
| Bytes returned to the caller | 5,823 | 827 |
| Of which the answer itself | 5,823 | 286 |
| Upstream calls | 8 | 8, inside one `execute` |

Fetch is 5,223 of the 5,823 flat bytes. The other seven results sum to 600 bytes. On a task whose results are already small, the Code Mode envelope (the answer plus the call trace) can be larger than those small results. The payload win shows up when a result is big and the program does not return it.

If each flat result stays in the conversation, later turns re-read the earlier ones. The prefix sums of those eight results add up to 13,595 bytes seen across the turns, against one 827-byte `execute` result. A prompt cache would not remove that growth. It would only change how often the 31,179-byte catalog is billed. This run did not measure a cache.

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
| Bytes of results | 12,699 | 1,822 |
| Re-read across later turns | 172,698 | 1,822 |
| Answer | | `{ orders: 25, paid: 19, total: 1906.81 }` |

The results are small one by one. The cost is the loop. Each turn re-reads every result before it, so 12,699 bytes of results become 172,698 bytes of context read across 26 turns. The program reads all 25 files with `Promise.all` and returns 39 bytes of answer plus the call trace. Most of the 1,822-byte envelope is that trace, one entry per call.

A client that issues parallel tool calls can do the flat version in 2 turns: list, then 25 reads at once. That removes most of the re-reading. It still puts all 12,699 bytes in the conversation, and the model still adds up 19 totals by hand.

## Time

Three runs each. Fetch is about nine tenths of the wall clock on both sides.

| | Min | Median | Max |
| --- | ---: | ---: | ---: |
| Eight direct calls | 1,792 ms | 2,285 ms | 2,559 ms |
| One `execute` | 1,713 ms | 1,756 ms | 2,094 ms |

The gap is inside the noise of one network fetch, which is most of either column. Code Mode does not make upstream calls faster. The upstream calls dominate, and the sandbox adds well under a millisecond per run. The local tasks above took 4 to 28 ms either way.

No model was in the loop, so none of these times include model turns. In practice a turn costs seconds. The 26-turn fan-out is where that difference would show.

## Startup

An MCP client launches the server and waits for the handshake before it can call anything. `scripts/measure.mjs` launches `serve` over stdio against the seven servers, times the handshake and the first `search` from launch, then waits two seconds for a model turn and times the first `execute` that calls `time`. Three runs each, launches four seconds apart so the previous run's upstream processes have exited.

| | Handshake | First `search` | First `execute`, after the turn |
| --- | ---: | ---: | ---: |
| 0.1.1 | 1,680 ms | 1,697 ms | 41 ms |
| Empty tool cache | 300 ms | 1,816 ms | 35 ms |
| Cached tool lists | 300 ms | 314 ms | 36 ms |
| Cached, `--lazy` | 283 ms | 296 ms | 597 ms |

Medians. 0.1.1 connected to every server before it answered the handshake. Now the handshake comes back in about 300 ms, mostly Node starting. With an empty cache the first `search` still waits for the seven servers, about as long as 0.1.1 took. That run writes the cache.

With cached tool lists the first `search` answers in about 314 ms, 5.4 times sooner, and no server has to be up for it. The servers connect in the background meanwhile. The model's turn hides that launch, so the first `execute` finds `time` already connected. `--lazy` skips the background launch: an unused server never starts, and the first call to a server pays for its launch, here about 560 ms for `uvx`.

The 0.1.1 row was measured with the same script against a build of the `v0.1.1` tag (`git worktree add ../v011 v0.1.1`).

## Turns

| Path | Turns for this task |
| --- | --- |
| Flat MCP | 8, one per call |
| Inline SDK | 1 |
| Progressive, methods already known | 1 |
| Progressive, lookup outside the sandbox | 10: one search, eight describes, one execute |
| Progressive, one search per method, signatures in the hits | 9: eight searches, one execute |

`codemode.search` and `codemode.describe` run inside `execute`, so the lookup does not have to be ten turns.

The first three hits of a search now carry their TypeScript signature. For five queries against this catalog (`current time timezone`, `read file`, `git log`, `create entities memory`, `fetch url`) the first hit was the method the query was after every time, and the signatures added 550 to 980 bytes to a response of 1,500 to 2,800. A `describe` of one of the eight methods above averages 764 bytes and costs a turn. Whether a model then skips that turn is a question for a run with a model in it.

## With a model

`scripts/bench-model.mjs` gives the same model the same three tasks twice. Plain MCP exposes the 55 tools directly as functions, 32,885 bytes of definitions. MCPtoCodeMode exposes `search`, `describe`, and `execute` through the real MCP server, 2,943 bytes. Each answer is checked against the fixture. Tokens and cost are what OpenRouter reported. Temperature 0, three runs per cell, medians. 23 October 2026.

- **log**: count the `ERROR` lines in the 2,000-line log and give the last job number.
- **orders**: count the paid orders among 25 files and total them.
- **mixed**: the latest commit subject from git and the text of a file from filesystem.

| Model | Task | Plain: tokens in | Code Mode: tokens in | Plain: turns | Code Mode: turns | Plain: cost | Code Mode: cost |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Claude Sonnet 5.5 | log | 101,244 | 8,093 | 2 | 3 | $0.204 | $0.019 |
| Claude Sonnet 5.5 | orders | 46,875 | 12,918 | 3 | 4 | $0.105 | $0.033 |
| Claude Sonnet 5.5 | mixed | 25,408 | 10,943 | 2 | 3 | $0.053 | $0.025 |
| Claude Haiku 5.5 | log | 101,244 | 7,942 | 2 | 3 | $0.011 | $0.001 |
| Claude Haiku 5.5 | orders | 46,875 | 31,169 | 3 | 5 | $0.005 | $0.004 |
| Claude Haiku 5.5 | mixed | 25,408 | 11,167 | 2 | 3 | $0.003 | $0.001 |

Across all 18 runs per model:

| | Plain MCP | MCPtoCodeMode |
| --- | ---: | ---: |
| Correct answers, Sonnet | 9 / 9 | 9 / 9 |
| Correct answers, Haiku | 9 / 9 | 9 / 9 |
| Input tokens, Sonnet | 520,581 | 92,406 (5.6× fewer) |
| Input tokens, Haiku | 520,581 | 139,453 (3.7× fewer) |
| Cost, Sonnet | $1.086 | $0.219 (5.0× less) |
| Turns, Sonnet | 21 | 29 |

Both arms answered every task correctly, so the difference is cost, not accuracy, on tasks this size. Plain MCP needed fewer turns. The models called tools in parallel: the 25 order files went out in one turn, not 25, which the byte-level fan-out above does not assume. MCPtoCodeMode usually spent one extra turn on `search`, and once or twice on fixing a program. Wall clock came out about even, within a second either way per task.

The log task is where output types matter. Before signatures carried `outputSchema`, `filesystem.read_text_file` read as `Promise<unknown>`. Haiku returned the whole file from `execute` to see its shape, then misread the `{ ok, result }` envelope: 5 turns and 242,886 input tokens, more than plain MCP. With `Promise<{ content: string }>` in the signature it filters in the sandbox on the first try: 3 turns and 7,942 tokens.

Raw results, with a per-turn trace of every tool call, are in `experiments/model-bench.json`. Repeat with `OPENROUTER_API_KEY=... pnpm build && pnpm bench:model`. This run cost $1.38.

## What this does not say

Outside the model section, bytes are not tokens and dividing by 4 is a stand-in. The model section covers three small tasks and two models. It does not say how either arm does on long, open-ended work. It does not compare stdio, streamable HTTP, and SSE. It does not price a provider's prompt cache. One catalog, one machine, one afternoon.
