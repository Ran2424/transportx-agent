"""Verify the three display classes using a frozen Hongqiao OSM extract."""
import hashlib
import json
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def main(osm, module, output):
    from inspect_network import inspect

    osm, module = osm.resolve(), module.resolve()
    output.mkdir()
    output = output.resolve()
    manifest = json.loads((module / 'manifest.json').read_text())
    runtime = next(item for item in manifest['contributes']['nativeRuntimes'] if item['kind'] == 'sumo')
    netconvert = module / runtime['executables']['netconvert']['path']
    assert hashlib.sha256(netconvert.read_bytes()).hexdigest() == runtime['executables']['netconvert']['sha256']
    imported = output / 'hongqiao.net.xml'
    with (output / 'netconvert.log').open('w') as log:
        subprocess.run([str(netconvert), '--osm-files', str(osm), '--output-file', str(imported),
                        '--keep-edges.by-type', 'railway.rail,railway.highspeed,railway.subway',
                        '--osm.extra-attributes', 'highspeed', '--output.street-names', 'true',
                        '--xml-validation', 'never'],
                       env={'PROJ_DATA': str(module / runtime['projData'])}, stdout=log,
                       stderr=subprocess.STDOUT, timeout=60, check=True)
    ways = {way.get('id'): {tag.get('k'): tag.get('v') for tag in way.findall('tag')}
            for way in ET.parse(osm).getroot().findall('way')}
    network = ET.parse(imported)
    highspeed, conventional, subway = '252713389', '360674887', '376634457'
    assert ways[highspeed]['highspeed'] == 'yes' and ways[highspeed]['ref'] == '3008'
    assert ways[conventional]['name'] == '沪昆线' and ways[conventional]['ref'] == '0008'
    assert ways[subway]['railway'] == 'subway'
    expected = {highspeed: 'railway.highspeed', conventional: 'railway.rail', subway: 'railway.subway'}
    covered = {}
    for edge in network.getroot().findall('edge'):
        edge_id = edge.get('id')
        way = edge_id.lstrip('-').split('#')[0]
        if way not in expected:
            continue
        assert edge.get('type') == expected[way]
        if way == conventional:
            # The OpenRailwayMap line table identifies 0008 as the conventional
            # Shanghai–Kunming trunk line. Keep this annotation fixture-local.
            edge.set('type', 'railway.conventional')
        covered[edge_id] = edge.get('type')
    assert set(covered.values()) == {'railway.highspeed', 'railway.conventional', 'railway.subway'}
    annotated = output / 'classification.net.xml'
    network.write(annotated, encoding='utf-8')
    geometry_path = output / 'geometry.json'
    inspect(annotated, {'roadRoute': [next(iter(covered))]}, 'road', geometry_path)
    geometry = json.loads(geometry_path.read_text())
    types = {feature['id']: feature['properties'].get('networkType') for feature in geometry['features']}
    assert all(types[edge] == expected_type for edge, expected_type in covered.items())
    assert 'railway.rail' in types.values(), 'Unknown track classes remain neutral'
    evidence = {'osmSha256': hashlib.sha256(osm.read_bytes()).hexdigest(), 'ways': {
        way: ways[way] for way in expected}, 'types': covered,
        'unknownRail': sum(t == 'railway.rail' for t in types.values())}
    (output / 'evidence.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main(*(Path(value) for value in sys.argv[1:]))
