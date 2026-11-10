# SUMO P0 probe

This is the executable technical probe described in `docs/交通仿真与优化能力升级 P0 记录.md`. It is not an installed Module or a public execution API. All network geometry, demand and service parameters are synthetic and uncalibrated.

Use the task's configured Python 3.10 through `TAU_PYTHON_COMMAND`. The lock below contains the measured macOS arm64 wheels; Windows native execution has not been verified.

```sh
mkdir -p tmp
"$TAU_PYTHON_COMMAND" -m pip install --only-binary=:all: --require-hashes \
  --target tmp/simulation-deps -r scripts/simulation/requirements.txt
TRANSPORTX_SIMULATION_DEPS="$PWD/tmp/simulation-deps" npm run test:simulation
```

The probe prints its evidence directory. It builds a synthetic network, relocates the native dependency closure and Python clients, runs real simulations, independently verifies outputs, reads blocks during execution, and injects cancellation / engine failure. It fails if required runtime or assertions are unavailable. It never installs dependencies at runtime or uses inherited Host credentials.

To repeat computation against a previously verified relocated runtime, set `TRANSPORTX_SIMULATION_RUNTIME` to that directory instead of installing again. Its adjacent `runtime-evidence.json` and native file hashes must verify. This reuses the measured runtime and does not constitute another cold relocation test.

Keep the generated evidence directories under `tmp/`; they contain raw tripinfo, frozen jobs, metrics, complete blocks, event ranges, indexes and manifests. The committed acceptance JSON records hashes and summaries without committing native binaries or developer interpreter paths.
