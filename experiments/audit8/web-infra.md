# Audit 8: web / infra / repo hygiene findings

## 1. CI runs untrusted fork-PR code under `pull_request_target` in jobs that hold VERCEL_TOKEN / CODECOV_TOKEN ("pwn request")
- **Severity:** high
- **Category:** security
- **Location:** .github/workflows/ci.yml:8, :37-52 (build-runtime), :195-236 (test), :369-410 (deploy-vercel)
- **Problem:** The workflow triggers on `pull_request_target` (base-repo context, secrets available) and, for fork PRs only, checks out the attacker's head and runs their scripts:
  ```yaml
  pull_request_target:
    branches: [main]
  ...
  deploy-vercel:
    if: github.event_name == 'pull_request_target' && github.event.pull_request.head.repo.full_name != github.repository
    - uses: actions/checkout@v4
      with:
        ref: ${{ github.event.pull_request.head.sha }}
    - run: cd web && npm ci
    - run: cd web && npm run build
    - uses: amondnet/vercel-action@v25
      with:
        vercel-token: ${{ secrets.VERCEL_TOKEN }}
  ```
  The `test` job does the same with `npm ci` / `npm run test:coverage` followed by `codecov/codecov-action` with `secrets.CODECOV_TOKEN`. The `permissions: contents: read` setting does not apply to repository secrets. The earlier fix (PR #245 / #299, see improvements/work*/AUDIT_WORK_REPORT.md) only added `pull_request` next to it and called it a "permissions gate". That gate covers GITHUB_TOKEN, not secrets.
- **How to reproduce:** Open a PR from a fork whose `web/package.json` has `"build": "env | base64 > /tmp/x; ..."` or whose build writes `NODE_OPTIONS=--require ./steal.js` to `$GITHUB_ENV`. The next step (the Vercel action) runs Node with the attacker's preload and can read `VERCEL_TOKEN` from its inputs.
- **Impact:** Any GitHub user can exfiltrate the Vercel and Codecov tokens and poison the base-branch `actions/setup-node` npm cache. Approval is required only if the `pr-preview` environment has protection rules, and nothing in the repo enforces that.
- **Proposed fix:** Remove `pull_request_target` from ci.yml. Run fork PRs via `pull_request` (no secrets). If preview deploys are needed, use a separate `workflow_run` workflow that deploys only a pre-built artifact and never runs PR code, or require a maintainer-applied label plus a protected environment.
- **Regression check:** Add a CI lint step (e.g. `zizmor` or `actionlint` plus a grep) that fails if any workflow has `pull_request_target` together with `ref: ${{ github.event.pull_request.head.* }}`.
- **Acceptance criteria:** No workflow runs PR-head code in a context where `secrets.*` are available. The zizmor "dangerous-triggers" check is clean.
- **Verification evidence:** `grep -n 'pull_request_target\|head.sha\|secrets\.' .github/workflows/ci.yml` shows the trigger at line 8, head checkouts at 39/129/167/207 and secrets at 234/406-410 in the same fork-only jobs.

## 2. install.sh installs the upstream TONresistor repo/image instead of this fork, and refuses fork clones
- **Severity:** medium
- **Category:** correctness (supply chain)
- **Location:** install.sh:6, :9-10, :101-106; package.json:19-26; packages/sdk/package.json:36-38
- **Problem:**
  ```sh
  REPO="tonresistor/teleton-agent"
  DOCKER_IMAGE="ghcr.io/${REPO}:latest"
  ...
  local expected_url="https://github.com/${REPO}.git"
  if [ "${actual_url}" != "${expected_url}" ]; then error "...unexpected origin..."
  ```
  README.md:131/146 and compose.yaml:12 tell users to use `xlabtg/teleton-agent` and `ghcr.io/xlabtg/teleton-agent`, and release.yml pushes images to the current repo's ghcr. The installer still clones upstream and pulls the upstream image. The `repository`, `bugs` and `homepage` fields in both package.json files also point to TONresistor.
- **How to reproduce:** Run `bash install.sh` and choose git mode. It clones TONresistor, so none of the fork's security fixes are included. If `~/.teleton-app` was cloned from `https://github.com/xlabtg/teleton-agent.git` as README.md:146 says, the installer aborts with "unexpected origin".
- **Impact:** Users silently get different code (without the fork's fixes) from what the docs and release pipeline describe. Fork users cannot update through the installer. Bug reports go to the wrong tracker.
- **Proposed fix:** Set `REPO="xlabtg/teleton-agent"`, update the usage URL and the package.json `repository`/`bugs`/`homepage` fields (root and SDK), or derive them from one source.
- **Regression check:** Add a test or CI grep that fails if `install.sh` or `package.json` mention `tonresistor/teleton-agent` (case-insensitive), except the "upstream" credit in README.
- **Acceptance criteria:** The installer's clone URL, docker image, and package metadata all name `xlabtg/teleton-agent`. An existing xlabtg clone updates without error.
- **Verification evidence:** `grep -n REPO= install.sh` returns `tonresistor/teleton-agent`. `git remote -v` returns xlabtg.

## 3. Tracked scratch/automation artefacts in repo root leak bot paths and include a destructive auto-commit/push script
- **Severity:** low
- **Category:** maintainability / security hygiene
- **Location:** APPLY_LOG.txt, DUMP.txt, CR_SNAPSHOT.txt, STATE2.txt, VERIFY_STATE.txt, COMMIT_RESULT.txt, REPORT.txt, PIPELINE.status, PR_BODY.md, commit_and_push.sh:5,27-73, run_pipeline.sh:5, report.sh:3, apply_a11y.py:11
- **Problem:** All of these are tracked (`git ls-files`); they were added by commit 55ce5a4d "Auto-commit before critical-error recovery". The scripts hard-code the solver's working directory and do git writes:
  ```sh
  cd /tmp/gh-issue-solver-1780101166480
  rm -f apply_a11y.py run_pipeline.sh DUMP.txt ...
  rm -rf web/test-results web/a11y-report
  git merge origin/main --no-edit
  git push origin issue-499-aa140238a8b8
  ```
  No secrets were found. They are not in the npm tarball (`files`: dist/, bin/, src/templates/) or the image (Dockerfile COPYs specific paths). They are, however, sent in the Docker build context because `.dockerignore` does not exclude them.
- **How to reproduce:** `git ls-files | grep -E '^(APPLY_LOG|DUMP|CR_SNAPSHOT|STATE2|VERIFY_STATE)\.txt|commit_and_push.sh'`. Running `sh commit_and_push.sh` on a machine where that /tmp path exists would rm files, commit, merge and push to a stale branch.
- **Impact:** Repo clutter, leaked internal tooling paths and branch names, and a footgun script that can push.
- **Proposed fix:** `git rm` these files. Add a `.gitignore` rule (e.g. `/*.txt` except allowed ones, `PIPELINE.status`, `/commit_and_push.sh`, `/run_pipeline.sh`, `/report.sh`, `/apply_a11y.py`) and matching `.dockerignore` entries.
- **Regression check:** Add a CI step that fails if `git ls-files` matches a root-level denylist (`*_LOG.txt`, `DUMP.txt`, `STATE*.txt`, `*.status`, `/tmp/gh-issue-solver` string in tracked files).
- **Acceptance criteria:** None of the listed files are tracked. `grep -rn gh-issue-solver $(git ls-files)` returns nothing outside experiments/.
- **Verification evidence:** The `git ls-files` output includes all the listed files. `grep` found `/tmp/gh-issue-solver-1780101166480` in 4 tracked scripts.

## 4. compose.yaml publishes the WebUI (full agent control, wallet) on all host interfaces by default
- **Severity:** medium
- **Category:** security
- **Location:** compose.yaml:29-32
- **Problem:**
  ```yaml
  TELETON_WEBUI_ENABLED: "true"
  TELETON_WEBUI_HOST: 0.0.0.0
  ports:
    - "${TELETON_WEBUI_PORT:-7777}:7777"
  ```
  A short-form port mapping binds 0.0.0.0 on the host, and Docker also bypasses ufw/iptables INPUT rules. On a VPS, the WebUI (config, exec, wallet operations) becomes internet-reachable, protected only by the bearer token, and it serves plain HTTP. The helm chart, by contrast, defaults to ClusterIP.
- **How to reproduce:** Run `docker compose up -d` on a cloud host, then `curl http://<public-ip>:7777/health` from outside, which returns `{"status":"ok"}`.
- **Impact:** Remote attack surface (token brute force, sniffing the token over plaintext HTTP), contrary to the local-first default of the non-docker install.
- **Proposed fix:** Use `"127.0.0.1:${TELETON_WEBUI_PORT:-7777}:7777"` and document opting in to a public bind (behind a TLS reverse proxy).
- **Regression check:** Add a CI step that runs `docker compose config` and asserts `ports[0].host_ip == "127.0.0.1"`.
- **Acceptance criteria:** By default the WebUI is reachable only from the host's loopback interface.
- **Verification evidence:** compose.yaml:31-32 as quoted. This was not found in /tmp/prior-issues.txt (only #498/#512 introduced the deployment artifacts).
