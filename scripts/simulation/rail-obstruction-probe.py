"""Exercise the released engine and service ledger with controlled SUMO rail occupancy."""
import copy
import hashlib
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def probe(job_path, module, output):
    sys.path[:0] = [str(module / 'scripts'), str(module / 'runtimes/sumo/python')]
    import compute
    import engine
    import traci

    original = json.loads(job_path.read_text())
    plan = original['scenario']['rail']
    transfer = plan['stops'][plan['boardingStop']]
    terminal = plan['stops'][-1]['platformId']
    end = original['scenario']['durationSeconds']
    train_id, blocker = plan['trainId'], 'probe-obstruction'
    assert plan['boardingStop'] == 1 and len(plan['stops']) == 3
    runtime = next(item for item in json.loads((module / 'manifest.json').read_text())
                   ['contributes']['nativeRuntimes'] if item['kind'] == 'sumo')
    sumo = module / runtime['executables']['sumo']['path']
    assert digest(sumo) == runtime['executables']['sumo']['sha256']
    output.mkdir()
    results = {}
    for name, stop_index, release in [('control', None, 0), ('insertion-delayed', 0, 120),
                                      ('platform-delayed', 1, 430), ('platform-window-end', 1, end + 30)]:
        root = output / name
        root.mkdir()
        job = copy.deepcopy(original)
        job['runId'] = 'sim_' + hashlib.sha256(f"{original['runId']}:{name}".encode()).hexdigest()[:32]
        job['execution'].update(outputRoot=str(root), sumo=str(sumo), projData=str(module / runtime['projData']))
        compute.validate(job)
        encoded_job = output / f'{name}.job.json'
        encoded_job.write_text(json.dumps(job, indent=2) + '\n')
        observed_pending = []

        class ObstructedEngine(engine.Engine):
            def initialize(self, job):
                super().initialize(job)
                if stop_index is None:
                    return
                stop = plan['stops'][stop_index]
                lane = f"{stop['edge']}_{stop['lane']}"
                exit_position = min(stop['position'] + 100, traci.lane.getLength(lane))
                assert exit_position > stop['position']
                traci.route.add(blocker, [stop['edge']])
                traci.vehicle.add(blocker, blocker, typeID='transportx-metro', depart='0',
                                  departLane=str(stop['lane']), departPos=str(stop['position']), departSpeed='0',
                                  arrivalPos=str(exit_position))
                traci.vehicle.setStop(blocker, stop['edge'], pos=stop['position'], laneIndex=stop['lane'],
                                      duration=1, until=release)
                self.scheduled[blocker] = 0

            def observe(self, time):
                result = super().observe(time)
                if train_id in self.pending:
                    observed_pending.append(time)
                return result

        actual_engine = engine.Engine
        try:
            engine.Engine = ObstructedEngine
            compute.run(job, digest(encoded_job))
        finally:
            engine.Engine = actual_engine

        result = json.loads((root / 'result.json').read_text())
        index = json.loads((root / 'index.json').read_text())
        events = [event for chunk in index['chunks'] for event in json.loads((root / chunk['events']['path']).read_text())]
        frames = {frame['time']: frame for chunk in index['chunks']
                  for frame in json.loads((root / chunk['path']).read_text())['frames']}
        raw_trips = {item.get('id'): item.attrib for item in ET.parse(root / 'tripinfo.xml').getroot()}
        trip = raw_trips[train_id]
        stop_output = ET.parse(root / 'stops.xml').getroot()
        raw_stops = [item.attrib for item in stop_output.findall(f"stopinfo[@id='{train_id}']")]
        rail_events = [event for event in events if event['type'] in ('metro_arrived', 'metro_departed')]
        rail_boardings = [event for event in events if event['type'] == 'metro_boarded']
        completions = [event for event in events if event['type'] == 'journey_completed' and event.get('vehicle') == train_id]
        misses = [event for event in events if event['type'] == 'connection_missed']
        service = result['metrics']['service']
        assert result['termination'] == 'completed' and index['final'] and index['availableTime'] == end == result['finalTime']
        assert not result['diagnostics']
        assert sum(service['states'].values()) == service['totalTravelers']
        for raw, stop in zip(raw_stops, plan['stops']):
            assert raw['lane'] == f"{stop['edge']}_{stop['lane']}"
            observed = [e for e in rail_events if e['nodeId'] == stop['platformId']]
            assert [e['type'] for e in observed] == ['metro_arrived', 'metro_departed'], observed
            assert [e['observedTime'] for e in observed] == [float(raw['started']), float(raw['ended'])], observed
        depart = float(trip['depart'])
        if name == 'insertion-delayed':
            assert plan['insertTime'] + 1 in observed_pending and depart > release > plan['insertTime'], trip
            assert train_id not in frames[plan['insertTime'] + 1]['vehicles']
        else:
            assert depart == plan['insertTime'] and not observed_pending, trip
        queue, blocked_frame = None, None
        if stop_index == 1:
            sample = frames[transfer['departure']]
            train, obstruction = sample['vehicles'][train_id], sample['vehicles'][blocker]
            assert obstruction['stopped'] and obstruction['lane'] == train['lane']
            assert train['speed'] == 0 and not train['stopped'] and train['lanePositionMeters'] < transfer['position'] - 80
            queue = sum(person['state'] == 'connecting' for person in sample['travelers'].values())
            assert queue == 4 and all(e['time'] > transfer['departure'] for e in rail_boardings + misses)
            blocked_frame = {'time': sample['time'], 'train': train, 'obstruction': obstruction}
        if name == 'platform-window-end':
            assert len(raw_stops) == 1 and len(rail_events) == 2
            assert not rail_boardings and not misses and not completions and float(trip['arrival']) < 0
            assert service['states'] == {'connecting': 4} and service['lastServiceMisses'] == service['completedJourneys'] == 0
        else:
            assert len(raw_stops) == 3 and len(rail_events) == 6
            if stop_index == 1:
                assert float(raw_stops[1]['started']) >= release
            else:
                assert float(raw_stops[1]['ended']) == transfer['departure']
            assert float(raw_stops[1]['ended']) - float(raw_stops[1]['started']) >= transfer['minDwell']
            departures = [e for e in rail_events if e['nodeId'] == transfer['platformId'] and e['type'] == 'metro_departed']
            assert len(departures) == 1
            boarded = {e['objectId'] for e in rail_boardings}
            assert len(rail_boardings) == len(boarded) == original['scenario']['coordination']['metro'][0]['capacity']
            assert all(e['time'] == departures[0]['time'] and e['vehicle'] == train_id for e in rail_boardings)
            final_arrival = next(e for e in rail_events if e['nodeId'] == terminal and e['type'] == 'metro_arrived')
            assert len(completions) == len(boarded) == service['completedJourneys']
            assert {e['objectId'] for e in completions} == boarded and all(e['time'] == final_arrival['time'] for e in completions)
            assert len(misses) == service['lastServiceMisses'] == 1 and misses[0]['reason'] == 'capacity'
        results[name] = {'runId': job['runId'], 'nativeTrip': trip, 'nativeStops': raw_stops, 'pendingSamples': observed_pending,
                         'obstructionTrip': raw_trips.get(blocker), 'blockedFrame': blocked_frame,
                         'obstructionRelease': release, 'transferQueueAtPlannedDeparture': queue,
                         'railEvents': rail_events, 'boardings': rail_boardings, 'completions': completions,
                         'connectionMisses': misses, 'finalStates': service['states'],
                         'files': {path.name: digest(path) for path in root.iterdir()}}
    evidence = {'inputJobSha256': digest(job_path), 'networkSha256': original['network']['sha256'],
                'implementation': original['implementation'], 'sumoVersion': runtime['version'],
                'plannedInsertion': plan['insertTime'], 'plannedTransferDeparture': transfer['departure'],
                'end': end, 'runs': results}
    (output / 'evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
    for name, result in results.items():
        print(name, result['nativeTrip']['depart'], [stop['ended'] for stop in result['nativeStops']], result['finalStates'])


if __name__ == '__main__':
    probe(*(Path(arg).resolve() for arg in sys.argv[1:]))
