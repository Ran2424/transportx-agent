"""Bounded read-only network preparation; no Pi, browser or SUMO process."""
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
import sumolib
from sumolib.geomhelper import positionAtShapeOffset
from blocks import atomic, digest, encode


def inspect(network, mapping, model, output, service=None):
    data = Path(network).read_bytes()
    if len(data) > 2 * 1024 * 1024 or any(value in data.lower() for value in [b'<!doctype', b'<!entity', b'<include']):
        raise ValueError('unsafe_network_xml')
    xml = ET.fromstring(data)
    if xml.tag != 'net' or any(key.lower() in ['file', 'href'] for node in xml.iter() for key in node.attrib):
        raise ValueError('network_indirect_reference')
    location = xml.find('location')
    projection = location.get('projParameter', '!') if location is not None else '!'
    if projection in ['', '!']:
        raise ValueError('network_georeference_missing')
    # The first product importer supports explicit UTM/WGS84 only; reject file-based grids and pipelines.
    fields = projection.split()
    if any(field not in ['+proj=utm', '+ellps=WGS84', '+datum=WGS84', '+units=m', '+no_defs', '+south'] and not (field.startswith('+zone=') and field[6:].isdigit() and 1 <= int(field[6:]) <= 60) for field in fields) or '+proj=utm' not in fields:
        raise ValueError('network_projection_unsupported')
    net = sumolib.net.readNet(network)
    route = mapping['roadRoute']
    for edge_id in route:
        if not net.hasEdge(edge_id):
            raise ValueError('mapping_edge_missing')
    for first, second in zip(route, route[1:]):
        if net.getEdge(second) not in net.getEdge(first).getOutgoing():
            raise ValueError('route_disconnected')
    if model == 'evacuation':
        roles = mapping['edges']
        cycle = [roles[key] for key in ['hub', 'outbound', 'relay', 'inbound', 'hub']]
        for first, second in zip(cycle, cycle[1:]):
            if not net.hasEdge(first) or not net.hasEdge(second) or net.getEdge(second) not in net.getEdge(first).getOutgoing():
                raise ValueError('service_route_disconnected')
        for role in ['hub', 'relay']:
            edge = net.getEdge(roles[role])
            if edge.getLaneNumber() < 2 or edge.getLength() < 30:
                raise ValueError('service_berths_unsupported')
    if model == 'multimodal':
        if service.get('rail'):
            from rail import validate_rail
            validate_rail(service['rail'], service, service['durationSeconds'], network)
        for node in service['nodes']:
            if not net.hasEdge(node['edge']):
                raise ValueError('service_node_edge_missing')
            edge = net.getEdge(node['edge'])
            for berth in node['berths']:
                if berth['lane'] >= edge.getLaneNumber() or berth['position'] > edge.getLane(berth['lane']).getLength() - 5:
                    raise ValueError('service_berth_outside_lane')
        for route in service['routes']:
            for key in ['outbound', 'inbound']:
                for first, second in zip(route[key], route[key][1:]):
                    if not net.hasEdge(first) or not net.hasEdge(second) or net.getEdge(second) not in net.getEdge(first).getOutgoing():
                        raise ValueError('service_route_disconnected')
    features = []
    for edge in net.getEdges():
        coordinates = [list(net.convertXY2LonLat(x, y)) for x, y in edge.getShape()]
        if len(coordinates) < 2 or any(not -180 <= lon <= 180 or not -90 <= lat <= 90 for lon, lat in coordinates):
            raise ValueError('network_geography_invalid')
        properties = {'edgeId': edge.getID()}
        if edge.getType():
            properties['networkType'] = edge.getType()
        features.append({'type': 'Feature', 'id': edge.getID(), 'properties': properties,
                         'geometry': {'type': 'LineString', 'coordinates': coordinates}})
    routes = {'route:road': mapping['roadRoute']}
    if model == 'evacuation':
        routes.update({'route:shuttle': cycle, 'route:ridehail': cycle})
        for role in ['hub', 'relay']:
            x, y = positionAtShapeOffset(net.getEdge(mapping['edges'][role]).getLane(0).getShape(), 20)
            features.append({'type': 'Feature', 'id': 'node:' + role, 'properties': {'nodeId': 'node:' + role},
                             'geometry': {'type': 'Point', 'coordinates': list(net.convertXY2LonLat(x, y))}})
    elif model == 'multimodal':
        routes.update({route['id']: route['outbound'] + route['inbound'][1:] for route in service['routes']})
        for node in service['nodes']:
            berth = node['berths'][0]
            x, y = positionAtShapeOffset(net.getEdge(node['edge']).getLane(berth['lane']).getShape(), berth['position'])
            features.append({'type': 'Feature', 'id': node['id'], 'properties': {'nodeId': node['id']},
                             'geometry': {'type': 'Point', 'coordinates': list(net.convertXY2LonLat(x, y))}})
        rail = service.get('rail')
        if rail:
            routes[rail['lineId']] = rail['edges']
            for stop in rail['stops']:
                lane = net.getEdge(stop['edge']).getLane(stop['lane'])
                x, y = positionAtShapeOffset(lane.getShape(), stop['position'])
                features.append({'type': 'Feature', 'id': stop['platformId'], 'properties': {'nodeId': stop['platformId']},
                                 'geometry': {'type': 'Point', 'coordinates': list(net.convertXY2LonLat(x, y))}})
    geometry = {'type': 'FeatureCollection', 'features': features, 'routes': routes}
    if len(features) > 5000 or len(encode(geometry)) > 2 * 1024 * 1024:
        raise ValueError('network_geometry_budget')
    artifact = atomic(str(Path(output).parent), Path(output).name, geometry)
    print(json.dumps({'protocol': 'transportx-network-inspection', 'version': 1, 'networkSha256': digest(data),
                      'geometry': artifact, 'projection': projection, 'edgeCount': len(features)}))


if __name__ == '__main__':
    try:
        inspect(sys.argv[1], json.loads(sys.argv[2]), sys.argv[3], sys.argv[4], json.loads(sys.argv[5]) if len(sys.argv) > 5 else None)
    except Exception as error:
        print(json.dumps({'code': 'traffic_network_invalid', 'message': str(error)}), file=sys.stderr)
        sys.exit(1)
