"""Explicit calculation entry. Workspace and Module authorization belong to the Host."""
import datetime
import json
import os
from pathlib import Path
import tracemalloc
import re
import signal
import sys
import time
import xml.etree.ElementTree as ET
from blocks import Blocks, atomic, digest
from model import Ledger, validate_service
from multimodal import Ledger as MultimodalLedger, validate as validate_multimodal


def integer(value, low, high):
    return type(value) is int and low <= value <= high


def validate(job):
    if set(job) != {'protocol', 'version', 'runId', 'provenance', 'implementation', 'scenario', 'network', 'mapping', 'execution'} or job['protocol'] != 'transportx-simulation-job' or type(job['version']) is not int or job['version'] != 2:
        raise ValueError('job_version')
    code = [{'name': name, 'sha256': digest(Path(__file__).with_name(name).read_bytes())} for name in ['compute.py', 'engine.py', 'model.py', 'blocks.py', 'multimodal.py']]
    from blocks import encode
    if job['implementation'] != {'version': '0.3.0', 'sha256': digest(encode(code))}:
        raise ValueError('implementation_version')
    provenance = job['provenance']
    if set(provenance) != {'kind', 'description', 'validDate', 'modelValidation'} or provenance['kind'] not in ['synthetic', 'assumed', 'observed', 'operating-plan'] or provenance['modelValidation'] != 'not_calibrated' or not isinstance(provenance['description'], str) or not 1 <= len(provenance['description']) <= 2000:
        raise ValueError('provenance_invalid')
    scenario = job['scenario']
    fields = {'schemaVersion', 'model', 'networkVersion', 'serviceDate', 'timezone', 'startTime', 'durationSeconds', 'seed', 'stepSeconds', 'decisionSeconds', 'sampleSeconds', 'blockSeconds', 'units', 'backgroundCount'}
    if scenario.get('model') == 'evacuation':
        fields.add('service')
    if scenario.get('model') == 'multimodal':
        fields.add('coordination')
    if set(scenario) != fields or type(scenario['schemaVersion']) is not int or scenario['schemaVersion'] != 1 or scenario['model'] not in ['road', 'evacuation', 'multimodal']:
        raise ValueError('scenario_fields')
    if not isinstance(scenario['networkVersion'], str) or not 1 <= len(scenario['networkVersion']) <= 160:
        raise ValueError('network_version')
    if not isinstance(scenario['startTime'], str) or not re.fullmatch(r'([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]', scenario['startTime']):
        raise ValueError('clock_invalid')
    datetime.date.fromisoformat(scenario['serviceDate'])
    if provenance['validDate'] != scenario['serviceDate']:
        raise ValueError('provenance_date_mismatch')
    datetime.datetime.strptime(scenario['startTime'], '%H:%M:%S')
    if scenario['timezone'] != 'Asia/Shanghai' or scenario['units'] != {'time': 's', 'distance': 'm', 'speed': 'm/s'}:
        raise ValueError('clock_or_units')
    if not integer(scenario['durationSeconds'], 1, 3600) or not integer(scenario['seed'], 0, 2147483647) or not integer(scenario['backgroundCount'], 0, 1000):
        raise ValueError('scenario_budget')
    if any(type(scenario[key]) is not int or scenario[key] != expected for key, expected in [('stepSeconds', 1), ('decisionSeconds', 1), ('sampleSeconds', 2), ('blockSeconds', 10)]):
        raise ValueError('sampling_unsupported')
    if 'service' in scenario:
        validate_service(scenario['service'])
    if 'coordination' in scenario:
        validate_multimodal(scenario['coordination'])
    network, mapping, execution = job['network'], job['mapping'], job['execution']
    if set(network) != {'path', 'sha256', 'version'} or network['version'] != scenario['networkVersion']:
        raise ValueError('network_version')
    p = Path(network['path'])
    if not p.is_absolute() or any(part.is_symlink() for part in [p, *p.parents]):
        raise ValueError('network_path')
    data = p.read_bytes()
    if len(data) > 2 * 1024 * 1024 or digest(data) != network['sha256'] or any(token in data.lower() for token in [b'<!doctype', b'<!entity', b'<include']):
        raise ValueError('network_integrity')
    net = ET.fromstring(data)
    if net.tag != 'net' or any(child.tag not in {'location', 'type', 'edge', 'junction', 'connection', 'tlLogic', 'roundabout', 'prohibition'} for child in net):
        raise ValueError('network_reference')
    if any(key.lower() in ['file', 'href'] for node in net.iter() for key in node.attrib):
        raise ValueError('network_reference')
    if not set(mapping) <= {'version', 'networkVersion', 'networkSha256', 'roadRoute', 'edges'} or mapping.get('version') != 1 or mapping.get('networkVersion') != network['version'] or mapping.get('networkSha256') != network['sha256']:
        raise ValueError('mapping_invalid')
    edges = {edge.attrib['id'] for edge in net.findall('edge')}
    route = mapping.get('roadRoute')
    if not isinstance(route, list) or not 1 <= len(route) <= 100 or any(not isinstance(edge, str) or edge not in edges for edge in route):
        raise ValueError('mapping_invalid')
    if scenario['model'] == 'evacuation':
        service_edges = mapping.get('edges')
        if not isinstance(service_edges, dict) or set(service_edges) != {'hub', 'outbound', 'relay', 'inbound'} or len(set(service_edges.values())) != 4 or not set(service_edges.values()) <= edges:
            raise ValueError('mapping_invalid')
    elif 'edges' in mapping:
        raise ValueError('mapping_invalid')
    if scenario['model'] == 'multimodal':
        lanes = {edge.attrib['id']: edge.findall('lane') for edge in net.findall('edge')}
        connections = {(row.get('from'), row.get('to')) for row in net.findall('connection')}
        for node in scenario['coordination']['nodes']:
            for berth in node['berths']:
                if node['edge'] not in lanes or berth['lane'] >= len(lanes[node['edge']]) or berth['position'] > float(lanes[node['edge']][berth['lane']].get('length')) - 5:
                    raise ValueError('service_berth_outside_lane')
        for route in scenario['coordination']['routes']:
            for key in ['outbound', 'inbound']:
                if not set(route[key]) <= edges or any(pair not in connections for pair in zip(route[key], route[key][1:])):
                    raise ValueError('service_route_disconnected')
    if not {'outputRoot', 'sumo', 'wallSeconds', 'maxOutputBytes'} <= set(execution) or not set(execution) <= {'outputRoot', 'sumo', 'wallSeconds', 'maxOutputBytes', 'projData'} or not integer(execution['wallSeconds'], 1, 60) or not integer(execution['maxOutputBytes'], 1, 64 * 1024 * 1024):
        raise ValueError('execution_budget')
    for key in ['outputRoot', 'sumo'] + (['projData'] if 'projData' in execution else []):
        target = Path(execution[key])
        if not target.is_absolute() or any(part.is_symlink() for part in [target, *target.parents]):
            raise ValueError('execution_path')
    if list(Path(execution['outputRoot']).iterdir()):
        raise ValueError('output_not_empty')
    return job


def run(job, job_sha256):
    from engine import Engine
    tracemalloc.start()
    started, rules_seconds, snapshot_seconds = time.perf_counter(), 0.0, 0.0
    blocks, engine = Blocks(job), None
    scenario = job['scenario']
    ledger = Ledger(scenario['service']) if scenario['model'] == 'evacuation' else MultimodalLedger(scenario['coordination']) if scenario['model'] == 'multimodal' else None
    cancelled = False

    def stop(_signum, _frame):
        nonlocal cancelled
        cancelled = True

    signal.signal(signal.SIGTERM, stop)
    engine = Engine(job, lambda: cancelled)
    atomic(blocks.root, 'started.json', {'pythonPid': os.getpid(), 'sumoPid': engine.process.pid,
           'engineVersion': engine.version, 'command': engine.command,
           'environmentKeys': sorted(os.environ), 'startedWallNs': time.time_ns()})
    termination, final_time, failure = 'completed', 0, None
    try:
        for t in range(scenario['durationSeconds'] + 1):
            if cancelled:
                termination = 'cancelled'
                break
            if time.perf_counter() - started > job['execution']['wallSeconds']:
                raise RuntimeError('wall_budget_exceeded')
            if t:
                engine.step()
            if t and t % scenario['blockSeconds'] == 0 and t != scenario['durationSeconds']:
                blocks.publish()
            vehicles, departed, arrived = engine.observe(t)
            now = time.perf_counter()
            emit = lambda kind, object_id, **detail: blocks.emit(t, kind, object_id, **detail)
            for vid in sorted(departed):
                emit('vehicle_inserted', vid)
            for vid in sorted(arrived):
                emit('vehicle_removed', vid)
            if ledger:
                ledger.update(t, vehicles, emit)
            rules_seconds += time.perf_counter() - now
            if ledger:
                ledger.apply(engine, emit)
            now = time.perf_counter()
            state = dict(time=t, generatedWallNs=time.time_ns(), vehicles=vehicles)
            if ledger:
                state.update(ledger.snapshot())
            blocks.sample(state)
            snapshot_seconds += time.perf_counter() - now
            final_time = t
    except Exception as error:
        termination, failure = ('cancelled' if cancelled else 'failed'), str(error)
    finally:
        try:
            engine.close(cancelled)
            exited = True
        except Exception as error:
            exited = engine.exited
            termination, failure = 'unknown', str(error)
        if termination in ['completed', 'cancelled']:
            blocks.publish(final=termination == 'completed')
    if digest(Path(job['network']['path']).read_bytes()) != job['network']['sha256']:
        termination, failure = 'failed', 'input_changed_during_run'
    diagnostics = []
    try:
        records = ET.parse(os.path.join(blocks.root, 'tripinfo.xml')).getroot().findall('tripinfo')
        raw_inserted = {row.attrib['id'] for row in records if float(row.attrib['depart']) >= 0}
        raw_pending = {row.attrib['id'] for row in records if float(row.attrib['depart']) < 0}
        if len(records) != len(engine.scheduled) or raw_inserted != engine.departed or raw_pending != engine.pending | engine.not_due:
            diagnostics.append('raw_vehicle_count_mismatch')
    except (ET.ParseError, OSError):
        diagnostics.append('raw_output_incomplete')
    if diagnostics and termination == 'completed':
        termination, failure = 'failed', diagnostics[0]
    metrics = {'road': {'planned': len(engine.scheduled), 'inserted': len(engine.departed), 'arrived': len(engine.arrived), 'activeOrUnfinished': len(engine.active), 'pendingInsertion': sorted(engine.pending), 'notYetDue': sorted(engine.not_due), 'peakActive': engine.peak_active}}
    if scenario['model'] == 'multimodal' and not diagnostics:
        observed = [row for row in records if float(row.attrib['depart']) >= 0]
        loss = sum(float(row.attrib['timeLoss']) for row in observed)
        elapsed = sum(float(row.attrib['duration']) for row in observed)
        metrics['road'].update(timeLossVehicleSeconds=loss, observedVehicleSeconds=elapsed, meanTimeLossSeconds=loss / len(observed) if observed else None,
                               meanObservedDurationSeconds=elapsed / len(observed) if observed else None,
                               meanTrafficWaitingSeconds=sum(float(row.attrib['waitingTime']) for row in observed) / len(observed) if observed else None,
                               aggregateSpeedMetersPerSecond=sum(float(row.attrib['routeLength']) for row in observed) / elapsed if elapsed else None)
    if ledger:
        metrics['service'] = ledger.metrics()
    atomic(blocks.root, 'metrics.json', metrics)
    files = []
    for p in sorted(Path(blocks.root).iterdir()):
        if p.is_file() and not p.name.endswith('.part'):
            data = p.read_bytes()
            files.append({'path': p.name, 'bytes': len(data), 'sha256': digest(data)})
    result = {'protocol': 'transportx-simulation-result', 'version': 1, 'runId': job['runId'],
              'jobSha256': job_sha256, 'networkSha256': job['network']['sha256'], 'durationSeconds': scenario['durationSeconds'],
              'finalTime': final_time, 'termination': termination, 'failure': failure, 'engineExited': exited,
              'engineExitCode': engine.exit_code,
              'eventCount': sum(chunk['eventCount'] for chunk in blocks.chunks), 'producedEventCount': blocks.next_event,
              'diagnostics': diagnostics, 'metrics': metrics, 'files': files,
              'timings': dict(engine.timings, rulesSeconds=rules_seconds, snapshotSeconds=snapshot_seconds, writeSeconds=blocks.write_seconds,
                              wallSeconds=time.perf_counter() - started),
              'maxBufferedBlockBytes': blocks.max_buffer_bytes, 'writtenBlockBytes': blocks.written_bytes,
              'pythonPeakTracedBytes': tracemalloc.get_traced_memory()[1],
              'source': job['provenance']['kind'], 'calibration': 'not_calibrated'}
    atomic(blocks.root, 'result.json', result)
    if termination not in ['completed', 'cancelled']:
        error = RuntimeError(failure or termination)
        error.code = 'simulation_result_unknown' if termination == 'unknown' else 'simulation_execution_failed'
        raise error


if __name__ == '__main__':
    phase = 'validation'
    try:
        with open(sys.argv[1], encoding='utf-8') as file:
            job = json.load(file, parse_constant=lambda value: (_ for _ in ()).throw(ValueError('nonfinite_json')))
        validate(job)
        phase = 'execution'
        run(job, digest(Path(sys.argv[1]).read_bytes()))
    except Exception as error:
        print(json.dumps({'protocol': 'transportx-simulation-error', 'version': 1, 'code': getattr(error, 'code', 'simulation_input_invalid' if phase == 'validation' else 'simulation_execution_failed'), 'phase': phase, 'message': str(error)}), file=sys.stderr)
        sys.exit(1)
