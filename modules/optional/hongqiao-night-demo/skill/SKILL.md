---
name: hongqiao-night-demo
description: Locate a small synthetic Hongqiao-night transport example for testing road and multimodal service experiments; all parameters are uncalibrated.
---

# Synthetic night demo

Read the selected asset `data:hongqiao-night-demo` from the task's Data asset mapping. `scenario.json` is the multimodal example; `road-scenario.json` exercises the same execution chain without travelers or services. Read `README.md` for coverage and assumptions.

Call `traffic_prepare_scenario` with the exact asset ID and one of those relative files. Label the scenario and every conclusion synthetic and uncalibrated. The geographic placement is illustrative and is not an actual Hongqiao road or operating plan. Do not use it to estimate real-world benefits.

## Paired P2 example

For a finite two-pickup, two-destination service example, use `multimodal-baseline.json` and `multimodal-threshold.json`. Prepare the baseline first; prepare the latter as its explicit variant with `interventions: ["policy"]`. Pass the user's existing rectangular/viewport Geo context when preparing the baseline; the variant inherits that same frozen selection. Then prepare `traffic_experiment` with at most three equal seeds and execute each next slot exactly once through `traffic_run`. Query the original experiment and preserve all incomplete samples. All operational inputs and route choices are synthetic assumptions, not observations or calibrated recommendations.
