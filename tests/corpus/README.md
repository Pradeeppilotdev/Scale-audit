# Real-repository regression corpus

The corpus compares complete audits of pinned repositories with the findings, scores, coverage and required detector names in [baseline.json](baseline.json). Findings retain rule ID, relative file, line, severity and confidence, including repeated entries. The baseline records observed analyzer behavior and can contain conservative findings. Rules with disputed behavior should have targeted source regressions as well.

## Run locally

GitHub CI runs both pinned cases on pushes to the main branch and on pull requests. It fetches the commit recorded in the baseline for each case.

Have Git and tar available, then obtain the pinned repositories if you do not already have local checkouts.

```sh
git clone https://github.com/Pradeeppilotdev/nanpolis.git ../nanpolis
git clone --depth 1 --branch v4.13.18 https://github.com/honojs/hono.git ../hono
npm run test:corpus -- nanpolis=../nanpolis hono=../hono
```

Pass either case by itself to run it independently. Both require the full hash of a commit and its files to be available in the local Git object store. The runner reads those objects through an isolated temporary repository. Committed `export-ignore` attributes define the archive contents, while file bytes remain as committed even if `export-subst` is set. Working-tree edits, installed dependencies, local replacement refs and checkout-specific attributes cannot change the archive. The runner scans the archive with the normal read-only audit and removes it after the run. It uses local objects and does not install or execute repository code. The regular test suite uses temporary local inputs and needs no external checkouts.

| Case | Pinned commit | Score | Coverage | Findings | Initial CLI wall time |
| --- | --- | ---: | ---: | ---: | ---: |
| nanpolis | `b57f16e469395fc079e13fa2b1a0957fb23bb9a2` | 98 | 15/15 | 39 | 0.38 s |
| Hono v4.13.18 | `f6fbaf0299c48eea9e656e03e2ffe7ac755e8823` | 96 | 241/241 | 23 | 1.14 s |

The harness prints audit time for each run, measured without archive extraction. Compare timings on the same machine and Node version. Timing is reported independently of pass/fail to avoid flaky failures from machine load. An incomplete audit, a missing required detector or any difference in coverage, findings or score exits with code 1. Additional completed detectors are allowed, and any findings they produce are included in the comparison.

## Update after an intentional analyzer change

Run the comparison first and review the added, removed and changed findings against the pinned source. If the differences are intentional, print the candidate baseline after building.

```sh
node tests/corpus/check.mjs --print nanpolis=../nanpolis hono=../hono > /tmp/scale-audit-corpus.json
```

Only replace the reviewed cases in `baseline.json`. To advance a repository, update its pin first, run against the new commit and review the source and finding differences before recording them. Keep commit pin changes separate from detector changes where possible.
