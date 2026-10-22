# Protocol comparison

Measured on 22 October 2026, Node v26.12.1, macOS, with MCPtoCodeMode 0.1.1. No model was in the loop. A script drove the same eight upstream calls through two hosts, so the numbers are about bytes and time, not about whether a model writes good code.

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
| Inline SDK | 1 | 23,123 | ~5,800 |
| Progressive Code Mode | 3 | 2,471 | ~620 |

The inline figure is 22,149 bytes of generated TypeScript plus the 974-byte `execute` tool. At 55 tools it is already about three quarters of the flat catalog (23,123 / 31,179). It grows with every new method. The three Code Mode tools do not.

The largest flat definitions were `sequentialthinking` (4,060 bytes), `everything__gzip-file-as-resource` (1,107), and `fetch` (1,052).

## Growth

The same catalog, adding one server at a time in config order.

| Servers | Added | Tools | Flat MCP | Inline SDK | Progressive Code Mode |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | everything | 16 | 7,298 | 6,118 | 2,471 |
| 2 | filesystem | 30 | 15,508 | 11,189 | 2,471 |
| 3 | memory | 39 | 20,037 | 14,735 | 2,471 |
| 4 | sequential-thinking | 40 | 24,097 | 16,510 | 2,471 |
| 5 | time | 42 | 25,284 | 18,139 | 2,471 |
| 6 | git | 54 | 30,127 | 21,597 | 2,471 |
| 7 | fetch | 55 | 31,179 | 23,002 | 2,471 |

Bytes in the prompt. Flat MCP averages about 570 bytes per tool here. One server with a few large schemas moves it more than several small ones: `sequential-thinking` is one tool and 4,060 bytes. With a single server, Code Mode is already a third of flat MCP. That gap only widens.

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
| Bytes of results | 12,699 | 1,826 |
| Re-read across later turns | 172,698 | 1,826 |
| Answer | | `{ orders: 25, paid: 19, total: 1906.81 }` |

The results are small one by one. The cost is the loop. Each turn re-reads every result before it, so 12,699 bytes of results become 172,698 bytes of context read across 26 turns. The program reads all 25 files with `Promise.all` and returns 39 bytes of answer plus the call trace. Most of the 1,826-byte envelope is that trace, one entry per call.

A client that issues parallel tool calls can do the flat version in 2 turns: list, then 25 reads at once. That removes most of the re-reading. It still puts all 12,699 bytes in the conversation, and the model still adds up 19 totals by hand.

## Time

Three runs each. Fetch is about nine tenths of the wall clock on both sides.

| | Min | Median | Max |
| --- | ---: | ---: | ---: |
| Eight direct calls | 1,978 ms | 2,529 ms | 2,745 ms |
| One `execute` | 2,123 ms | 2,726 ms | 5,093 ms |

The median gap is about 200 ms, inside the noise of one network fetch. The 5,093 ms run was a slow fetch. Code Mode is not faster here. The upstream calls dominate, and the sandbox adds a little. The local tasks above took 24 to 64 ms either way.

No model was in the loop, so none of these times include model turns. In practice a turn costs seconds. The 26-turn fan-out is where that difference would show.

## Turns

| Path | Turns for this task |
| --- | --- |
| Flat MCP | 8, one per call |
| Inline SDK | 1 |
| Progressive, methods already known | 1 |
| Progressive, lookup outside the sandbox | 10: one search, eight describes, one execute |

`codemode.search` and `codemode.describe` run inside `execute`, so the lookup does not have to be ten turns.

## What this does not say

Bytes are not tokens. Dividing by 4 is a stand-in. It does not say a model succeeds more often with one protocol than another, or that a model writes the program used here on the first try. It does not compare stdio, streamable HTTP, and SSE. It does not price a provider's prompt cache. One catalog, one machine, one afternoon.
