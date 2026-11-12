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

To open a verified event in Canvas, use `canvas_present` with adapter `com.transportx.traffic-simulation.canvas`, capability resource `com.transportx.traffic-simulation` and the Run ID. Set `operation` to `focus` and pass `target` with the event's `time`, `eventSequence` from its `sequence`, and a related `objectId` such as the event's node. Distinguish `requestedTime` from the sampled frame's `time` in the query. When the user attaches a Canvas context, use `canvas_inspect_context` to read the frozen Run, frame and event.

For the finite `multimodal` model, fixed route choices, node waiting capacity, physical berths, finite fleet, actual return motion, metro capacity and transfer/external times are explicit inputs. Full queues retain blocked upstream demand. The earlier `evacuation` profile remains the one-hub/relay example. Neither profile simulates indoor pedestrians or rail dynamics.

For comparisons, freeze the baseline with the user's existing `geoContextId` when supplied. Prepare the changed input with its `parentScenarioId` and exact `interventions` (`departures` and/or `policy`); unchanged demand, network, fleet and other conditions are required. Call `traffic_experiment` to validate the complete plan before dispatch: two scenarios, one to three distinct seeds, at most six Runs/3600 simulated seconds. Execute `traffic_run` with `experimentId` and each next `slot` exactly once. If its slot already owns a Run, query that Run; never replace an unknown/failed/cancelled slot automatically. A paused/hidden Canvas changes only viewing.

Query `traffic_experiment` for per-seed variant-minus-baseline differences, all Run states, immutable JSON evidence and the Markdown report. Report planned/complete pair counts and the difference distribution; incomplete pairs forbid a normal benefit conclusion. `meanHubWaitSeconds` includes all arrived travelers, including boarding and upstream blockage, and right-censors those not departed at finalTime. Road time loss includes all inserted vehicles; retain pending and unfinished counts. A single seed proves only function closure. Synthetic, uncalibrated differences establish no optimality, causality in observed traffic or real Hongqiao benefit.

Distinguish hub waiting from `waiting.meanAllWaitSeconds` and P90: the latter include waiting, upstream blockage, boarding and connecting, exclude walking/travel, and retain unfinished elapsed waiting. P90 uses nearest rank. Journey statistics name completed-only versus right-censored all-arrival windows; do not present censored durations as forecasts of complete journeys. `byRoute` and `nodes` retain each direction/mode and endpoint backlog. Fleet busy fractions count reservation-to-actual-return time within the simulation window; turnaround and load factors have explicit definitions and unresolved cycles remain censored. Compare realized trips and busy vehicle seconds as resource use, not invented monetary cost.

Use the existing Citation capability to register the concrete immutable comparison JSON and Markdown report with typed locators when delivering a report. Reuse the returned evidence IDs. Citation/presentation failure never authorizes recomputing Runs.

Road observed duration and total-distance/total-duration speed include planned stops and unfinished elapsed time. SUMO timeLoss and traffic waiting exclude planned stops; retain pending insertion separately. Do not label these different denominators as the same congestion indicator.
