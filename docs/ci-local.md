# Running CI Workflows Locally with `act`

`act` lets you run GitHub Actions workflows on your local machine using Docker,
giving fast feedback before pushing to GitHub.

## Install `act`

### CachyOS / Arch Linux

```bash
# Via AUR (or if the package is in the repos):
pacman -S act
# or
yay -S act
```

### GitHub-distributed binary (any Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/nektos/act/master/install.sh | sudo bash
# Binary is placed in /usr/local/bin/act
```

### macOS

```bash
brew install act
```

## Configuration

`.actrc` at the repo root is already configured to use the `catthehacker/ubuntu:act-24.04`
image, which includes the full Ubuntu 24.04 environment needed for apt-installed packages
(webkit2gtk, libvpx, etc.).

```
-P ubuntu-24.04=catthehacker/ubuntu:act-24.04
-P ubuntu-latest=catthehacker/ubuntu:act-24.04
```

The first run downloads the image (~1 GB). Subsequent runs reuse the cached image.

## Running Individual Jobs

```bash
# Run just the backend job (fastest feedback for backend changes)
act -j backend

# Run just the viewer job
act -j viewer

# Run the sharer compile-check job (slowest; Rust compile + clippy)
act -j sharer

# Run the e2e job (requires backend + viewer to pass first)
act -j e2e
```

## Simulating Events

```bash
# Simulate a push to main (runs all jobs in ci.yml)
act push

# Simulate a pull request
act pull_request

# Run the build-sharer workflow manually (workflow_dispatch)
act workflow_dispatch -W .github/workflows/build-sharer.yml

# Run only the Linux matrix leg (Windows jobs are skipped under act)
act workflow_dispatch -W .github/workflows/build-sharer.yml --matrix os:ubuntu-24.04
```

## Providing Secrets Locally

Create a `.secrets` file at the repo root (already gitignored):

```
TAURI_SIGNING_PRIVATE_KEY=<base64-encoded-private-key>
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<password>
GITHUB_TOKEN=<your-github-pat>
```

Run with secrets:

```bash
act -j backend --secret-file .secrets
```

Alternatively, pass individual secrets inline:

```bash
act -j backend -s GITHUB_TOKEN="$(gh auth token)"
```

## Debugging Failing Steps

```bash
# Verbose output for the sharer job
act -j sharer --verbose

# Keep the container running after failure for inspection
act -j sharer --reuse

# Drop into the container interactively (add a shell step temporarily)
act -j backend --interactive
```

## Known Limitations

- **Windows jobs** (`windows-latest`) cannot run under act on Linux/macOS. Skip them
  by targeting only the Linux job:
  ```bash
  act workflow_dispatch -W .github/workflows/build-sharer.yml --matrix os:ubuntu-24.04
  ```

- **macOS jobs** are not supported by act at all.

- **`actions-rust-lang/setup-rust-toolchain`** installs Rust inside the container.
  The first run is slow (downloads toolchain). Reuse the container to skip re-downloads:
  ```bash
  act -j sharer --reuse
  ```

- **Complex matrix** workflows: use `--matrix` to pin a single value when testing locally.

- The E2E job starts background processes (`npm run dev &`). Under act, background
  processes may not be cleaned up between steps — this is generally harmless for CI.

- **`act` vs real GitHub Actions**: `act` does not replicate GitHub-specific services
  (OIDC, GitHub Packages cache). The `GITHUB_TOKEN` inside act is a placeholder;
  Docker push steps will fail unless you provide a real token via `.secrets`.

## Verifying YAML Syntax Without `act`

If `act` is not available, validate YAML syntax:

```bash
# Via Python (available by default on most systems)
python3 -c "
import yaml, sys, pathlib
for f in pathlib.Path('.github/workflows').glob('*.yml'):
    try:
        yaml.safe_load(f.read_text())
        print(f'OK: {f}')
    except yaml.YAMLError as e:
        print(f'ERROR: {f}: {e}')
        sys.exit(1)
"

# Or via yamllint (install once)
pip install yamllint --break-system-packages --user
yamllint .github/workflows/*.yml
```
