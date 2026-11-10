---
name: traffic-simulation
description: Prepare and run bounded SUMO/TraCI traffic scenarios, inspect a Simulation Canvas and query reproducible road or multimodal evacuation experiments.
---

# Traffic simulation

Use Pi's normal tool loop. Discover and enable `com.transportx.traffic-simulation` through `manage_capabilities`; dependencies do not automatically enable their tools.

1. Locate an explicitly selected Data asset or task file containing a TrafficScenario. Keep its provenance, service date, network version, seed, demand and declared service assumptions. Use the installed demo only when an example is appropriate; identify it as synthetic and uncalibrated.
2. Call `traffic_prepare_scenario` with its relative path and the exact selected asset ID when applicable. Report missing or unsupported input from diagnostics. Do not invent confirmed demand, schedules or network geometry.
3. Call `traffic_run` with the prepared scenarioId. The Host owns the operation, output paths, budgets, programs and cancellation. Do not start SUMO through bash, substitute an interpreter, install dependencies or upload policy code.
4. The Simulation Canvas can open while computation runs. Pausing playback does not pause computation. Use `traffic_query_results` for a Run and explicit computed time/object; never infer future state from interpolated positions.
5. On a missing response, cancellation or unknown result, call `traffic_execution` to inspect the original runId or lookupToolCallId. Preserve outputs. Do not automatically create a replacement Run, even with a new call ID.
6. Distinguish leaving the hub, completing a road trip and completing the entire passenger journey. `hubDepartures`, `completedJourneys`, state counts and missed connections count people; `dispatchedTrips` counts vehicle trips. Retain waiting, connecting, in-vehicle, pending-insertion and not-yet-arrived demand in the denominator. A state difference is not a counterfactual causal effect. Report source and model validation status alongside results.
7. Vehicle `position` is global SUMO network XY in metres, not distance along a lane. Use only `lanePositionMeters` for lane distance; `positionGeo` is WGS84 longitude/latitude in degrees and speed is m/s. If an older Run lacks lane distance or node/route event associations, report that gap; do not reinterpret XY or claim that no event occurred.

The initial service model supports one hub/relay loop, two destination directions, one shuttle, one ridehail car, finite timetabled rail capacity and explicit external journey time. It does not simulate indoor pedestrians or rail dynamics, and makes no optimality or real Hongqiao benefit claim.
