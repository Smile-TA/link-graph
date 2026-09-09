# Recorded lychee output

`lychee-mixed.json` is the verbatim stdout of one real `lychee 0.24.2` run, captured
2026-09-02. `lychee-mixed-input.txt` is the URL list it was given, one per line, so line
N of that file is the input `span.line` N in the JSON refers to.

The run was:

```
lychee --format json --no-progress --verbose --max-retries 0 --host-concurrency 1 \
       --host-request-interval 10ms --max-concurrency 8 --timeout 3 \
       --user-agent 'link-graph/0.1 (+link audit)' --cache=false -- - < input.txt
```

against a local server serving one response shape per path, plus two real URLs. Twelve
URLs in, and it is the mismatches that make this worth checking in rather than writing
by hand:

| line | requested                     | what lychee did                                       |
| ---: | ----------------------------- | ----------------------------------------------------- |
|    1 | `/live/`                      | `success_map`, 200                                    |
|    2 | `/moved/` (301 → `/live/`)    | `success_map`, 200 — the redirect is followed silently |
|    3 | `/gone/`                      | `error_map`, 404                                      |
|    4 | `/forbidden/`                 | `error_map`, 403                                      |
|    5 | `/ratelimited/`               | `error_map`, 429                                      |
|    6 | `/boom/`                      | `error_map`, 500                                      |
|    7 | `/hang/`                      | `timeout_map`, **no status code**                     |
|    8 | `/ok.`                        | **rewritten** to `/ok`, then 404                      |
|    9 | `127.0.0.1:1/refused/`        | `error_map`, no code, "Connection refused"            |
|   10 | `https://…:8799/tls/`         | `error_map`, no code, TLS "corrupt message"           |
|   11 | `https://twitter.com/…`       | **`excluded_map`** — with no `--exclude` configured   |
|   12 | `tel:+1555…`                  | **absent from the JSON entirely**                     |

Lines 8, 11 and 12 are the reason `reconcile.ts` exists. `total` is 11, not 12.
