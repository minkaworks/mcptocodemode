# Protocol comparison

Measured on 22 October 2026, Node v26.12.1, macOS. No model was in the loop. A script drove the same eight upstream calls through two hosts, so the numbers are about bytes and time, not about whether a model writes good code.

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
| Inline SDK | 1 | 23,696 | ~5,900 |
| Progressive Code Mode | 3 | 2,471 | ~620 |

The inline figure is 22,722 bytes of generated TypeScript plus the 974-byte `execute` tool. At 55 tools it is already about three quarters of the flat catalog (23,696 / 31,179). It grows with every new method. The three Code Mode tools do not.

The largest flat definitions were `sequentialthinking` (4,060 bytes), `everything__gzip-file-as-resource` (1,107), and `fetch` (1,052).

## Discovery

Progressive Code Mode pays for schemas only when asked.

| Ask | Bytes |
| --- | ---: |
| `search` with an empty query, 8 hits | 2,030 |
| `describe` of the 8 methods this task calls | 6,108 |
| `describe` of all 7 servers | 22,601 |

Describing every server costs about the same as pasting the whole SDK (22,601 against 22,722). The saving is describing the methods you are about to call, or searching.

## One task

Eight calls, the same arguments on both sides: current time in `America/Mexico_City`, read one file, `git_log`, one thinking step, create a memory entity, read the graph, fetch the servers README, and `echo`. Fetch used the server's own length limit. The Code Mode program returned only the fields the task needed. The fetched page stayed in the sandbox.

| | Flat MCP | Code Mode |
| --- | ---: | ---: |
| Bytes returned to the caller | 5,823 | 827 |
| Of which the answer itself | 5,823 | 286 |
| Upstream calls | 8 | 8, inside one `execute` |

Fetch is 5,223 of the 5,823 flat bytes. The other seven results sum to 600 bytes. On a task whose results are already small, the Code Mode envelope (the answer plus the call trace) can be larger than those small results. The payload win shows up when a result is big and the program does not return it.

If each flat result stays in the conversation, later turns re-read the earlier ones. The prefix sums of those eight results add up to 13,595 bytes seen across the turns, against one 827-byte `execute` result. A prompt cache would not remove that growth. It would only change how often the 31,179-byte catalog is billed. This run did not measure a cache.

## Time

Three runs each. Fetch is about nine tenths of the wall clock on both sides.

| | Min | Median | Max |
| --- | ---: | ---: | ---: |
| Eight direct calls | 1,909 ms | 2,020 ms | 2,554 ms |
| One `execute` | 2,105 ms | 2,152 ms | 2,437 ms |

The median gap is 132 ms. Code Mode is not faster here. The upstream calls dominate, and the sandbox adds a little.

## Turns

| Path | Turns for this task |
| --- | --- |
| Flat MCP | 8, one per call |
| Inline SDK | 1 |
| Progressive, methods already known | 1 |
| Progressive, lookup outside the sandbox | 10: one search, eight describes, one execute |

`codemode.search` and `codemode.describe` run inside `execute`, so the lookup does not have to be ten turns.

## What this does not say

It does not say a model succeeds more often with one protocol than another. It does not compare stdio, streamable HTTP, and SSE. It does not price a provider's prompt cache. One catalog, one machine, one afternoon.
