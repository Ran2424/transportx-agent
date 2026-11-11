"""Check timetable control on the frozen Shanghai rail/road network."""

import hashlib
import json
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import sumolib


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def probe(source, module, output):
    network = source / 'corridor.net.xml'
    evidence = json.loads((source / 'physical-evidence.json').read_text())
    assert digest(network) == evidence['files']['corridor.net.xml']['sha256']
    runtime = next(item for item in json.loads((module / 'manifest.json').read_text())
                   ['contributes']['nativeRuntimes'] if item['kind'] == 'sumo')
    sumo = module / runtime['executables']['sumo']['path']
    assert digest(sumo) == runtime['executables']['sumo']['sha256']
    net = sumolib.net.readNet(network)
    paths = evidence['paths']
    edges = paths['rail']['edges']
    assert all(net.getEdge(edge).allows('subway') for edge in edges)
    first, middle, last = edges[0], edges[1], edges[-1]
    stops = [
        ('test-origin', first, 155.0),
        ('test-intermediate', middle, 900.0),
        ('test-destination', last, paths['rail']['stop'][2]),
    ]
    for _, edge, position in stops:
        lane = net.getEdge(edge).getLane(0)
        assert lane.allows('subway') and 80 < position < lane.getLength()
    output.mkdir()

    results = {}
    for name, depart, until in [('baseline', 35, 150), ('plus-one', 35, 151), ('late', 145, 150)]:
        root = output / name
        root.mkdir()
        routes = ET.parse(source / 'vehicles.rou.xml').getroot()
        for vehicle in routes.findall('vehicle'):
            if vehicle.get('id') not in ('bus-0', 'car-0', 'metro-0'):
                routes.remove(vehicle)
        train = routes.find("./vehicle[@id='metro-0']")
        train.set('depart', str(depart))
        train.set('departPos', '100')
        train.remove(train.find('stop'))
        for stop_id, edge, position in stops:
            attributes = {'lane': edge + '_0', 'endPos': str(position), 'duration': '8', 'actType': stop_id}
            if stop_id == 'test-intermediate':
                attributes['until'] = str(until)
            ET.SubElement(train, 'stop', attributes)
        routes[:] = sorted(routes, key=lambda element: float(element.get('depart', '-1')))
        ET.ElementTree(routes).write(root / 'vehicles.rou.xml', encoding='utf-8', xml_declaration=True)
        args = [
            str(sumo), '--net-file', str(network), '--route-files', 'vehicles.rou.xml',
            '--seed', '7', '--end', '600', '--step-length', '1', '--time-to-teleport', '-1',
            '--tripinfo-output', 'tripinfo.xml', '--stop-output', 'stops.xml',
            '--fcd-output', 'trajectory.xml', '--summary-output', 'summary.xml',
            '--xml-validation', 'never', '--no-step-log', 'true',
        ]
        with (root / 'sumo.log').open('w') as log:
            subprocess.run(args, cwd=root, env={'PROJ_DATA': str(module / runtime['projData'])},
                           stdout=log, stderr=subprocess.STDOUT, timeout=60, check=True)

        tripinfo = {row.get('id'): row.attrib for row in ET.parse(root / 'tripinfo.xml').getroot()}
        assert set(tripinfo) == {'bus-0', 'car-0', 'metro-0'}, tripinfo
        observations = [row.attrib for row in ET.parse(root / 'stops.xml').getroot()
                        if row.get('id') == 'metro-0']
        assert len(observations) == 3, observations
        for row, (_, edge, _) in zip(observations, stops):
            assert row['lane'] == edge + '_0' and float(row['ended']) - float(row['started']) >= 8, row
        sample_frames = ET.parse(root / 'trajectory.xml').getroot().findall('timestep')
        assert any({'bus-0', 'car-0', 'metro-0'} <= {item.get('id') for item in tick}
                   for tick in sample_frames)
        assert any(float(item.get('speed')) > 0 for tick in sample_frames
                   for item in tick.findall("vehicle[@id='metro-0']"))
        assert all(step.get('collisions') == step.get('teleports') == '0'
                   for step in ET.parse(root / 'summary.xml').getroot().findall('step'))
        results[name] = {'plannedIntermediateDeparture': until, 'stops': observations,
                         'trips': tripinfo, 'files': {p.name: digest(p) for p in root.iterdir()}}

    baseline, plus_one, late = (results[key]['stops'][1] for key in ('baseline', 'plus-one', 'late'))
    assert float(baseline['started']) + 8 <= 150 and float(baseline['ended']) == 150, baseline
    assert float(plus_one['ended']) == float(baseline['ended']) + 1, plus_one
    assert float(late['started']) > 150 and float(late['ended']) > 150, late
    summary = {'networkSha256': digest(network), 'sumoVersion': runtime['version'],
               'stopSource': 'synthetic test anchors on frozen Shanghai rail lanes',
               'stops': stops, 'runs': results}
    (output / 'evidence.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps({key: [row['started'], row['ended']] for key, row in
                      [('baseline', baseline), ('plus-one', plus_one), ('late', late)]}))


if __name__ == '__main__':
    probe(*(Path(arg).resolve() for arg in sys.argv[1:]))
