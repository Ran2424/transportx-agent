"""Import a pinned Shanghai OSM snapshot and run a physical three-mode SUMO probe."""
import hashlib
import json
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import sumolib
from sumolib.route import getLength


BBOX = (121.422, 31.150, 121.450, 31.179)
SOURCE = 'https://api.openstreetmap.org/api/0.6/map?bbox=121.422,31.150,121.450,31.179'
OSM_SHA256 = 'ebf7f2233dcf974af0bcb063816528c15424e705213e3167732bc08f1e3821aa'
ATTRIBUTION = '© OpenStreetMap contributors, ODbL — https://www.openstreetmap.org/copyright'
TYPES = 'highway.primary,highway.primary_link,highway.secondary,highway.secondary_link,highway.tertiary,highway.tertiary_link,highway.residential,highway.unclassified,railway.subway'
ROAD = ('1268580660', 0, 395.0), ('546374400#1', 1, 394.8)
METRO = ('93881218#0', 0, 160.9), ('321205032#4', 0, 1693.4)
LINE_3_RELATION = '6817178'
END_SECONDS = 1500


def file_record(path):
    data = path.read_bytes()
    return {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def run(binary, args, root, env, log):
    with (root / log).open('w') as stream:
        subprocess.run([binary, *args], cwd=root, env=env, stdout=stream,
                       stderr=subprocess.STDOUT, timeout=60, check=True)


def shortest(net, endpoints, mode):
    start, end = endpoints
    edges, distance = net.getShortestPath(net.getEdge(start[0]), net.getEdge(end[0]),
                                          vClass=mode, fromPos=start[2], toPos=end[2])
    assert edges and len(edges) <= 32, (mode, endpoints)
    assert all(edge.allows(mode) for edge in edges)
    for edge_id, lane, pos in endpoints:
        segment = net.getEdge(edge_id).getLane(lane)
        assert segment.allows(mode) and 10 <= pos <= segment.getLength() - 5
    return {'edges': [edge.getID() for edge in edges], 'meters': distance, 'start': start, 'stop': end}


def physical(net, paths, root, sumo, env):
    routes = ET.Element('routes')
    for mode, vehicle_class, length, speed in [('bus', 'bus', '10', '14'),
                                                ('metro', 'subway', '80', '19'),
                                                ('car', 'passenger', '4.5', '16')]:
        ET.SubElement(routes, 'vType', id=mode, vClass=vehicle_class, length=length, maxSpeed=speed)
    expected = {}
    for mode, count, begin in [('bus', 1, 0), ('metro', 1, 35), ('car', 12, 24)]:
        route = paths['rail' if mode == 'metro' else 'road']
        start, end = route['start'], route['stop']
        for i in range(count):
            vid = f'{mode}-{i}'
            expected[vid] = (mode, route)
            vehicle = ET.SubElement(routes, 'vehicle', id=vid, type=mode, depart=str(begin + i * 4),
                                    departLane=str(start[1]), departPos=str(start[2]), departSpeed='0',
                                    arrivalLane=str(end[1]), arrivalPos=str(end[2] + 5))
            ET.SubElement(vehicle, 'route', edges=' '.join(route['edges']))
            if mode != 'car':
                ET.SubElement(vehicle, 'stop', lane=f'{end[0]}_{end[1]}', endPos=str(end[2]), duration='8')
    routes[:] = sorted(routes, key=lambda row: int(row.get('depart', '-1')))
    ET.ElementTree(routes).write(root / 'vehicles.rou.xml', encoding='utf-8', xml_declaration=True)
    args = ['--net-file', 'corridor.net.xml', '--route-files', 'vehicles.rou.xml',
            '--seed', '7', '--end', str(END_SECONDS), '--step-length', '1', '--xml-validation', 'never',
            '--time-to-teleport', '-1', '--no-step-log', 'true', '--duration-log.disable', 'true',
            '--tripinfo-output', 'tripinfo.xml', '--tripinfo-output.write-unfinished', 'true',
            '--tripinfo-output.write-undeparted', 'true', '--stop-output', 'stops.xml',
            '--summary-output', 'summary.xml', '--fcd-output', 'trajectory.xml', '--device.fcd.period', '2']
    run(sumo, args, root, env, 'sumo.log')
    tripinfo = {row.attrib['id']: row.attrib for row in ET.parse(root / 'tripinfo.xml').getroot().findall('tripinfo')}
    assert set(tripinfo) == set(expected)
    summary = ET.parse(root / 'summary.xml').getroot().findall('step')
    assert summary and all(int(s.get('collisions', '-1')) == int(s.get('teleports', '-1')) == 0 for s in summary)
    stops = {row.get('id'): row.attrib for row in ET.parse(root / 'stops.xml').getroot().findall('stopinfo')}
    assert set(stops) == {'bus-0', 'metro-0'}, stops
    samples = {vid: [] for vid in expected}
    for tick in ET.parse(root / 'trajectory.xml').getroot().findall('timestep'):
        for row in tick.findall('vehicle'):
            samples[row.attrib['id']].append((float(row.get('x')), float(row.get('y')), float(row.get('speed'))))
    for vid, (mode, route) in expected.items():
        trip = tripinfo[vid]
        assert trip['vType'] == mode and 0 <= float(trip['depart']) < float(trip['arrival']) <= END_SECONDS, trip
        start, end = route['start'], route['stop']
        meters = getLength(net, route['edges']) - start[2] - net.getEdge(end[0]).getLength() + end[2] + 5
        # Actual lane choices may take a slightly different internal connection.
        assert 2700 < float(trip['routeLength']) < 3300 and abs(float(trip['routeLength']) - meters) <= 15, trip
        assert len(samples[vid]) > 10 and max(p[2] for p in samples[vid]) > 1, vid
        if vid in stops:
            stop = stops[vid]
            assert stop['lane'] == f"{route['stop'][0]}_{route['stop'][1]}"
            assert float(stop['ended']) - float(stop['started']) >= 8, stop
    return {'args': args, 'vehicles': tripinfo, 'stops': stops,
            'traceSamples': {vid: len(points) for vid, points in samples.items()},
            'collisions': 0, 'teleports': 0, 'endSeconds': END_SECONDS}


def main():
    osm, module, root = map(lambda value: Path(value).resolve(), sys.argv[1:4])
    root.mkdir()
    assert file_record(osm)['sha256'] == OSM_SHA256, 'Supply the frozen Shanghai OSM response'
    raw = ET.parse(osm).getroot()
    assert raw.tag == 'osm' and raw.findall('node') and raw.findall('way')
    relation = raw.find(f"./relation[@id='{LINE_3_RELATION}']")
    assert relation is not None and relation.find("./tag[@k='ref']").get('v') == '3'
    rail_ways = {member.get('ref') for member in relation.findall("member[@type='way']")}
    manifest = json.loads((module / 'manifest.json').read_text())
    runtime = next(value for value in manifest['contributes']['nativeRuntimes'] if value['kind'] == 'sumo')
    netconvert = module / runtime['executables']['netconvert']['path']
    sumo = module / runtime['executables']['sumo']['path']
    for name, file in [('netconvert', netconvert), ('sumo', sumo)]:
        assert file_record(file)['sha256'] == runtime['executables'][name]['sha256']
    env = {'PROJ_DATA': str(module / runtime['projData'])}
    args = ['--osm-files', str(osm), '--output-file', 'corridor.net.xml', '--geometry.remove', 'true',
            '--keep-edges.by-type', TYPES, '--output.street-names', 'true',
            '--no-turnarounds', 'true', '--xml-validation', 'never']
    run(netconvert, args, root, env, 'netconvert.log')
    network = root / 'corridor.net.xml'
    net = sumolib.net.readNet(network)
    road, rail = shortest(net, ROAD, 'bus'), shortest(net, METRO, 'subway')
    assert shortest(net, ROAD, 'passenger')['edges'] == road['edges']
    assert all(edge.lstrip('-').split('#')[0] in rail_ways for edge in rail['edges'])
    assert all(2700 < route['meters'] < 3300 for route in (road, rail))
    paths = {'road': road, 'return': shortest(net, ROAD[::-1], 'bus'), 'rail': rail}
    write_json(root / 'paths.json', paths)
    evidence = {'source': SOURCE, 'attribution': ATTRIBUTION, 'requestBboxWgs84': BBOX,
                'line3Relation': LINE_3_RELATION, 'sourceNodes': len(raw.findall('node')),
                'sourceWays': len(raw.findall('way')), 'networkEdges': len(net.getEdges()),
                'subwayEdges': sum(edge.allows('subway') for edge in net.getEdges()),
                'runtimeVersion': runtime['version'], 'netconvertArgs': args, 'paths': paths,
                'physical': physical(sumolib.net.readNet(network, withInternal=True), paths, root, sumo, env),
                'files': {p.name: file_record(p) for p in (osm, network, netconvert, sumo,
                          *(root / name for name in ('vehicles.rou.xml', 'tripinfo.xml', 'stops.xml',
                                                    'summary.xml', 'trajectory.xml', 'netconvert.log', 'sumo.log')))}}
    write_json(root / 'physical-evidence.json', evidence)
    print(json.dumps({'networkEdges': evidence['networkEdges'], 'roadMeters': road['meters'],
                      'metroMeters': rail['meters'], 'arrived': len(evidence['physical']['vehicles'])}))


if __name__ == '__main__':
    main()
