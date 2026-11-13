"""Physical metro service for the bounded single-train profile."""
import traci


def validate_rail(rail, service, duration, network):
    import sumolib

    if rail is None:
        return
    if set(rail) != set('mode lineId trainId serviceId insertTime startPosition edges boardingStop stops'.split()) or rail['mode'] != 'physical':
        raise ValueError('physical_metro_fields')
    if not rail['lineId'].startswith('route:metro-') or not rail['trainId'].startswith('train-') or rail['trainId'] in {vehicle['id'] for vehicle in service['fleet']}:
        raise ValueError('physical_metro_identity')
    stops, edges, boarding = rail['stops'], rail['edges'], rail['boardingStop']
    if len(service['metro']) != 1 or service['metro'][0]['id'] != rail['serviceId'] or type(boarding) is not int or not 0 <= boarding < len(stops) - 1:
        raise ValueError('physical_metro_service')
    if not 3 <= len(stops) <= 6 or not 3 <= len(edges) <= 32 or len(set(edges)) != len(edges):
        raise ValueError('physical_metro_stop_count')
    if type(rail['insertTime']) is not int or not 0 <= rail['insertTime'] <= duration or type(rail['startPosition']) is not int or not 80 <= rail['startPosition'] <= 10000:
        raise ValueError('physical_metro_start')
    net = sumolib.net.readNet(network)
    tracks = [net.getEdge(edge) for edge in edges]
    if any(not edge.allows('subway') for edge in tracks) or any(second not in first.getOutgoing() for first, second in zip(tracks, tracks[1:])):
        raise ValueError('physical_metro_track_disconnected')
    previous_index, previous_time = -1, rail['insertTime']
    platform_ids = {node['id'] for node in service['nodes']}
    for i, stop in enumerate(stops):
        if set(stop) != set('platformId edge lane position arrival departure minDwell'.split()) or not stop['platformId'].startswith('node:platform-') or stop['platformId'] in platform_ids:
            raise ValueError('physical_metro_platform')
        platform_ids.add(stop['platformId'])
        index = edges.index(stop['edge'])
        if not previous_index < index or i == 0 and (index != 0 or stop['position'] <= rail['startPosition']) or i == len(stops) - 1 and index != len(edges) - 1:
            raise ValueError('physical_metro_stop_order')
        if type(stop['lane']) is not int or not 0 <= stop['lane'] < tracks[index].getLaneNumber():
            raise ValueError('physical_metro_platform_lane')
        lane = tracks[index].getLane(stop['lane'])
        if not lane.allows('subway') or type(stop['position']) not in (int, float) or not 80 <= stop['position'] < lane.getLength() - 4:
            raise ValueError('physical_metro_platform_position')
        if any(type(stop[key]) is not int for key in ('arrival', 'departure', 'minDwell')) or not 1 <= stop['minDwell'] <= 120 or not previous_time <= stop['arrival'] <= stop['departure'] - stop['minDwell'] or stop['departure'] > duration:
            raise ValueError('physical_metro_timetable')
        previous_index, previous_time = index, stop['departure']
    if stops[boarding]['departure'] != service['metro'][0]['time']:
        raise ValueError('physical_metro_boarding_plan')


class MetroTrain:
    def __init__(self, plan):
        self.plan = plan
        self.arrivals, self.departures = set(), set()
        self.id = plan['trainId']
        traci.vehicletype.copy('DEFAULT_VEHTYPE', 'transportx-metro')
        traci.vehicletype.setVehicleClass('transportx-metro', 'subway')
        traci.vehicletype.setLength('transportx-metro', 80)
        traci.vehicletype.setMaxSpeed('transportx-metro', 19)
        traci.route.add(plan['lineId'], plan['edges'])
        traci.vehicle.add(self.id, plan['lineId'], typeID='transportx-metro', depart=str(plan['insertTime']),
                          departPos=str(plan['startPosition']), departLane=str(plan['stops'][0]['lane']),
                          departSpeed='0', arrivalLane=str(plan['stops'][-1]['lane']),
                          arrivalPos=str(plan['stops'][-1]['position'] + 4))
        traci.vehicle.setSpeedFactor(self.id, 1)
        for stop in plan['stops']:
            traci.vehicle.setStop(self.id, stop['edge'], pos=stop['position'], laneIndex=stop['lane'],
                                  duration=stop['minDwell'], until=stop['departure'])

    def observe(self, time, actual, emit):
        if not actual:
            return []
        actual['mode'] = 'metro'
        plan, changes = self.plan, []
        previous = traci.vehicle.getStops(self.id, -len(plan['stops']))

        def record(kind, i, observed):
            stop = plan['stops'][i]
            if not 0 <= observed <= time or int(observed) != observed:
                raise RuntimeError('physical_metro_clock')
            emit(kind, self.id, nodeId=stop['platformId'], service=plan['serviceId'], vehicle=self.id,
                 routeId=plan['lineId'], observedTime=int(observed))
            changes.append((kind, i, int(observed)))

        for i, stop in enumerate(previous):
            if i not in self.departures:
                if i not in self.arrivals:
                    raise RuntimeError('physical_metro_departure_without_arrival')
                record('metro_departed', i, stop.depart)
                self.departures.add(i)
        i = len(previous)
        if actual['stopped'] and i < len(plan['stops']) and i not in self.arrivals:
            stop, expected = traci.vehicle.getStops(self.id, 1)[0], plan['stops'][i]
            if stop.lane != expected['edge'] + '_' + str(expected['lane']) or abs(stop.endPos - expected['position']) > 0.1:
                raise RuntimeError('physical_metro_wrong_platform')
            record('metro_arrived', i, stop.arrival)
            self.arrivals.add(i)
        return changes
