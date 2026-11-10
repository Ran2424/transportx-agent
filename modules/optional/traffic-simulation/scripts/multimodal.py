"""Finite node/fleet ledger. Road motion and stop confirmation remain in SUMO."""
import copy
import math
import re
from collections import Counter


def validate(service):
    def fields(row, expected):
        if not isinstance(row, dict) or set(row) != set(expected.split()):
            raise ValueError('multimodal_fields')

    def number(value, low, high):
        if type(value) is not int or not low <= value <= high:
            raise ValueError('multimodal_number')

    fields(service, 'version nodes routes fleet boardingSeconds travelers departures metro policy')
    if type(service['version']) is not int or service['version'] != 2:
        raise ValueError('multimodal_version')
    number(service['boardingSeconds'], 1, 60)
    ids = set()
    for name, maximum, minimum in [('nodes', 8, 1), ('routes', 8, 1), ('fleet', 8, 1), ('travelers', 100, 1), ('departures', 32, 0), ('metro', 16, 0)]:
        rows = service[name]
        if not isinstance(rows, list) or not minimum <= len(rows) <= maximum:
            raise ValueError('multimodal_rows')
        for row in rows:
            value = row.get('id') if isinstance(row, dict) else None
            if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9:-]{0,119}', value) or value.startswith(('road-', 'feedback-')) or value in ids:
                raise ValueError('multimodal_id')
            ids.add(value)
    nodes = {row['id']: row for row in service['nodes']}
    for node in nodes.values():
        fields(node, 'id role edge waitingCapacity berths')
        if not node['id'].startswith('node:') or node['role'] not in ['pickup', 'transfer'] or not isinstance(node['edge'], str) or not 1 <= len(node['edge']) <= 160:
            raise ValueError('multimodal_node')
        number(node['waitingCapacity'], 1, 100)
        if not isinstance(node['berths'], list) or not 1 <= len(node['berths']) <= 4:
            raise ValueError('multimodal_berths')
        seen = set()
        for berth in node['berths']:
            fields(berth, 'lane position')
            number(berth['lane'], 0, 3)
            if type(berth['position']) not in [int, float] or not 10 <= berth['position'] <= 10000 or (berth['lane'], berth['position']) in seen:
                raise ValueError('multimodal_berth')
            seen.add((berth['lane'], berth['position']))
    routes = {row['id']: row for row in service['routes']}
    for route in routes.values():
        fields(route, 'id mode origin target destination outbound inbound transferSeconds externalSeconds')
        if not route['id'].startswith('route:') or route['id'] == 'route:road' or route['mode'] not in ['bus', 'ridehail'] or nodes.get(route['origin'], {}).get('role') != 'pickup' or nodes.get(route['target'], {}).get('role') != 'transfer' or not isinstance(route['destination'], str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9:-]{0,119}', route['destination']) or route['destination'].startswith(('road-', 'feedback-')):
            raise ValueError('multimodal_route')
        number(route['transferSeconds'], 0, 300)
        number(route['externalSeconds'], 1, 3600)
        for key, first, last in [('outbound', 'origin', 'target'), ('inbound', 'target', 'origin')]:
            edges = route[key]
            if not isinstance(edges, list) or not 2 <= len(edges) <= 32 or any(not isinstance(edge, str) or not 1 <= len(edge) <= 160 for edge in edges) or edges[0] != nodes[route[first]]['edge'] or edges[-1] != nodes[route[last]]['edge']:
                raise ValueError('multimodal_route_edges')
    fleet = {row['id']: row for row in service['fleet']}
    occupied = set()
    for vehicle in fleet.values():
        fields(vehicle, 'id mode capacity home berth')
        if vehicle['mode'] not in ['bus', 'ridehail'] or nodes.get(vehicle['home'], {}).get('role') != 'pickup' or vehicle['mode'] == 'ridehail' and vehicle['capacity'] != 1 or not any(route['origin'] == vehicle['home'] and route['mode'] == vehicle['mode'] for route in routes.values()):
            raise ValueError('multimodal_vehicle')
        number(vehicle['capacity'], 1, 40)
        number(vehicle['berth'], 0, len(nodes[vehicle['home']]['berths']) - 1)
        key = (vehicle['home'], vehicle['berth'])
        if key in occupied:
            raise ValueError('multimodal_home_conflict')
        occupied.add(key)
    for traveler in service['travelers']:
        fields(traveler, 'id time origin destination route')
        number(traveler['time'], 0, 7200)
        route = routes.get(traveler['route'], {})
        if traveler['origin'] != route.get('origin') or traveler['destination'] != route.get('destination'):
            raise ValueError('multimodal_itinerary')
    for trip in service['departures']:
        fields(trip, 'id time vehicle route')
        number(trip['time'], 0, 7200)
        route, vehicle = routes.get(trip['route'], {}), fleet.get(trip['vehicle'], {})
        if not route or not vehicle or route['origin'] != vehicle['home'] or route['mode'] != vehicle['mode']:
            raise ValueError('multimodal_trip')
    for train in service['metro']:
        fields(train, 'id time node destination capacity externalSeconds')
        number(train['time'], 0, 7200)
        number(train['capacity'], 1, 100)
        number(train['externalSeconds'], 1, 3600)
        if nodes.get(train['node'], {}).get('role') != 'transfer' or not any(route['mode'] == 'bus' and route['target'] == train['node'] and route['destination'] == train['destination'] for route in routes.values()):
            raise ValueError('multimodal_train')
    for route in routes.values():
        if route['mode'] == 'bus' and not any(train['node'] == route['target'] and train['destination'] == route['destination'] for train in service['metro']):
            raise ValueError('multimodal_connection_missing')
    policy = service['policy']
    if policy.get('kind') == 'fixed':
        fields(policy, 'kind')
    elif policy.get('kind') == 'queue-threshold':
        fields(policy, 'kind threshold cooldownSeconds routes')
        number(policy['threshold'], 1, 100)
        number(policy['cooldownSeconds'], 1, 600)
        if not isinstance(policy['routes'], list) or not 1 <= len(policy['routes']) <= 8 or len(set(policy['routes'])) != len(policy['routes']) or any(routes.get(route, {}).get('mode') != 'bus' for route in policy['routes']):
            raise ValueError('multimodal_policy_routes')
    else:
        raise ValueError('multimodal_policy')


class Ledger:
    def __init__(self, service):
        self.service = service
        self.nodes = {node['id']: node for node in service['nodes']}
        self.routes = {route['id']: route for route in service['routes']}
        self.people = {p['id']: dict(p, state='not_arrived', location=None, waitSeconds=0) for p in service['travelers']}
        self.vehicles = {v['id']: dict(v, state='inserting', occupants=[], trip=None, route=None, observedTrips=0, passengersBoarded=0, busySeconds=0, turnarounds=[]) for v in service['fleet']}
        self.reserved = {}
        self.handled, self.missed, self.last_missed = set(), set(), set()
        self.last_feedback, self.actions = {}, []
        self.trips, self.time = 0, 0

    def at_berth(self, actual, node_id, berth):
        node, position = self.nodes[node_id], self.nodes[node_id]['berths'][berth]
        return actual and actual['edge'] == node['edge'] and actual['stopped'] and actual['lane'].endswith('_' + str(position['lane'])) and abs(actual['lanePositionMeters'] - position['position']) <= 2

    def queue(self, route_id):
        return sorted((p for p in self.people.values() if p['state'] == 'waiting' and p['route'] == route_id), key=lambda p: (p['time'], p['id']))

    def node_count(self, node_id):
        return sum(p['location'] == node_id and p['state'] in ['waiting', 'walking', 'connecting'] for p in self.people.values())

    def update(self, time, road, emit):
        for p in self.people.values():
            if p['state'] in ['waiting', 'blocked', 'boarding', 'connecting']:
                p['waitSeconds'] += time - self.time
        self.time = time
        # Observe actual movement and destination stops before changing service state.
        for vid, vehicle in sorted(self.vehicles.items()):
            actual = road.get(vid)
            if vehicle['state'] == 'inserting':
                if self.at_berth(actual, vehicle['home'], vehicle['berth']):
                    vehicle['state'] = 'available'
                    emit('vehicle_available', vid, nodeId=vehicle['home'])
                continue
            if actual is None:
                raise RuntimeError('fleet_vehicle_missing')
            route = self.routes.get(vehicle['route'])
            if vehicle['state'] == 'commanded' and actual['speed'] > 0 and not actual['stopped']:
                vehicle['state'] = 'outbound'
                self.trips += 1
                vehicle['observedTrips'] += 1
                vehicle['passengersBoarded'] += len(vehicle['occupants'])
                vehicle['departureTime'] = time
                emit('departure_observed', vid, trip=vehicle['trip'], routeId=route['id'], nodeId=vehicle['home'])
                for pid in vehicle['occupants']:
                    self.people[pid].update(state='riding', hubDeparture=time)
                    emit('boarded', pid, vehicle=vid, trip=vehicle['trip'], routeId=route['id'], nodeId=vehicle['home'])
            if vehicle['state'] == 'outbound' and self.at_berth(actual, route['target'], vehicle['targetBerth']):
                needed = len(vehicle['occupants']) if route['mode'] == 'bus' else 0
                if self.node_count(route['target']) + needed > self.nodes[route['target']]['waitingCapacity']:
                    if not vehicle.get('blockedAtTarget'):
                        vehicle['blockedAtTarget'] = True
                        emit('alighting_blocked', vid, nodeId=route['target'], routeId=route['id'], reason='waiting_capacity')
                    continue
                for pid in vehicle['occupants']:
                    state = 'walking' if route['mode'] == 'bus' else 'external'
                    self.people[pid].update(state=state, location=route['target'] if state == 'walking' else 'external:' + route['destination'], ready=time + (route['transferSeconds'] if state == 'walking' else route['externalSeconds']))
                    emit('alighted', pid, vehicle=vid, nodeId=route['target'], routeId=route['id'])
                vehicle['occupants'] = []
                vehicle['state'] = 'return_commanded'
                self.actions.append((vid, route['inbound'], vehicle['home'], vehicle['berth'], 'return'))
            if vehicle['state'] == 'return_commanded' and actual['speed'] > 0 and not actual['stopped']:
                self.reserved.pop((route['target'], vehicle['targetBerth']))
                vehicle['state'] = 'returning'
            if vehicle['state'] == 'returning' and self.at_berth(actual, vehicle['home'], vehicle['berth']):
                vehicle['busySeconds'] += time - vehicle.pop('busyStart')
                vehicle['turnarounds'].append(time - vehicle.pop('departureTime'))
                vehicle.update(state='available', trip=None, route=None)
                emit('vehicle_available', vid, nodeId=vehicle['home'])
        for pid, p in sorted(self.people.items()):
            if p['state'] in ['walking', 'external'] and time >= p['ready']:
                if p['state'] == 'walking':
                    p['state'] = 'connecting'
                    emit('transfer_ready', pid, nodeId=p['location'], routeId=p['route'])
                else:
                    p.update(state='completed', location=p['destination'], completedAt=time)
                    emit('journey_completed', pid, routeId=p['route'])
        # Admit stable arrival order; full waiting areas retain upstream demand.
        arrivals = sorted((p for p in self.people.values() if p['state'] in ['not_arrived', 'blocked'] and p['time'] <= time), key=lambda p: (p['time'], p['id']))
        for p in arrivals:
            admitted = self.node_count(p['origin']) < self.nodes[p['origin']]['waitingCapacity']
            if admitted:
                p.update(state='waiting', location=p['origin'])
                emit('traveler_arrived', p['id'], nodeId=p['origin'], routeId=p['route'])
            elif p['state'] != 'blocked':
                p.update(state='blocked', location='upstream:' + p['origin'])
                emit('arrival_blocked', p['id'], nodeId=p['origin'], routeId=p['route'], reason='waiting_capacity')
        candidates = [trip for trip in self.service['departures'] if trip['time'] <= time and trip['id'] not in self.handled]
        policy = self.service['policy']
        if policy['kind'] == 'queue-threshold':
            for route_id in sorted(policy['routes']):
                queue = self.queue(route_id)
                if len(queue) >= policy['threshold'] and time - self.last_feedback.get(route_id, -policy['cooldownSeconds']) >= policy['cooldownSeconds']:
                    self.last_feedback[route_id] = time
                    route = self.routes[route_id]
                    available = [vid for vid, v in sorted(self.vehicles.items()) if v['home'] == route['origin'] and v['mode'] == 'bus' and v['state'] == 'available']
                    trip = dict(id='feedback-' + route_id + '-' + str(time), time=time, route=route_id, vehicle=available[0] if available else None)
                    emit('policy_observed', trip['id'], routeId=route_id, nodeId=route['origin'], observedTime=time, queueCount=len(queue), longestWaitSeconds=time - queue[0]['time'])
                    candidates.append(trip)
        for trip in sorted(candidates, key=lambda row: (row['time'], row['id'])):
            self.handled.add(trip['id'])
            route, vehicle = self.routes[trip['route']], self.vehicles.get(trip['vehicle'])
            queue = self.queue(route['id'])
            free = [i for i in range(len(self.nodes[route['target']]['berths'])) if (route['target'], i) not in self.reserved]
            reason = ('vehicle_unavailable' if not vehicle or vehicle['state'] != 'available' else 'vehicle_not_at_berth' if not self.at_berth(road.get(vehicle['id']), vehicle['home'], vehicle['berth']) else 'no_matching_demand' if not queue else 'target_berths_reserved' if not free else None)
            emit('action_candidate', trip['id'], vehicle=trip['vehicle'], routeId=route['id'], nodeId=route['origin'])
            if reason:
                emit('action_rejected', trip['id'], vehicle=trip['vehicle'], routeId=route['id'], nodeId=route['origin'], reason=reason)
                continue
            chosen = queue[:vehicle['capacity']]
            vehicle.update(state='boarding', trip=trip['id'], route=route['id'], occupants=[p['id'] for p in chosen], ready=time + self.service['boardingSeconds'], targetBerth=free[0], blockedAtTarget=False, busyStart=time)
            self.reserved[(route['target'], free[0])] = vehicle['id']
            for p in chosen:
                p.update(state='boarding', location=vehicle['id'])
            emit('action_reserved', trip['id'], vehicle=vehicle['id'], routeId=route['id'], nodeId=route['origin'], travelers=vehicle['occupants'])
        for vid, v in sorted(self.vehicles.items()):
            if v['state'] == 'boarding' and time >= v['ready']:
                v['state'] = 'commanded'
                route = self.routes[v['route']]
                self.actions.append((vid, route['outbound'], route['target'], v['targetBerth'], 'dispatch'))
        for train in sorted(self.service['metro'], key=lambda row: (row['time'], row['id'])):
            if train['time'] > time or train['id'] in self.handled:
                continue
            self.handled.add(train['id'])
            queue = sorted((p for p in self.people.values() if p['state'] == 'connecting' and p['location'] == train['node'] and p['destination'] == train['destination']), key=lambda p: (p['ready'], p['id']))
            for p in queue[:train['capacity']]:
                p.update(state='external', location=train['id'], ready=time + train['externalSeconds'], metroBoardedAt=time)
                emit('metro_boarded', p['id'], service=train['id'], nodeId=train['node'], routeId=p['route'])
            for p in queue[train['capacity']:]:
                self.missed.add(p['id'])
                emit('connection_missed', p['id'], service=train['id'], nodeId=train['node'], routeId=p['route'], reason='capacity')
        for pid, p in sorted(self.people.items()):
            route = self.routes[p['route']]
            trains = [train for train in self.service['metro'] if train['node'] == route['target'] and train['destination'] == p['destination']]
            if p['state'] == 'connecting' and time >= max(train['time'] for train in trains) and pid not in self.missed:
                self.missed.add(pid)
                emit('connection_missed', pid, nodeId=p['location'], routeId=p['route'], reason='last_service_closed')
            if route['mode'] == 'bus' and p['time'] <= time and time >= max(train['time'] for train in trains) and 'metroBoardedAt' not in p and pid not in self.last_missed:
                self.last_missed.add(pid)
                self.missed.add(pid)
                emit('last_connection_missed', pid, nodeId=route['target'], routeId=p['route'], reason='last_service_closed')
        self.check()

    def apply(self, engine, emit):
        for vid, edges, node, berth, kind in self.actions:
            engine.move_fleet(vid, edges, self.nodes[node], berth)
            emit('engine_accepted', vid, action=kind, trip=self.vehicles[vid]['trip'], routeId=self.vehicles[vid]['route'], nodeId=node)
        self.actions.clear()

    def check(self):
        occupants = [pid for v in self.vehicles.values() for pid in v['occupants']]
        if len(occupants) != len(set(occupants)) or sorted(occupants) != sorted(pid for pid, p in self.people.items() if p['state'] in ['boarding', 'riding']):
            raise RuntimeError('traveler_conservation')
        for vid, v in self.vehicles.items():
            if len(v['occupants']) > v['capacity'] or any(self.people[pid]['location'] != vid for pid in v['occupants']):
                raise RuntimeError('fleet_capacity_or_location')
        if any(self.node_count(node) > value['waitingCapacity'] for node, value in self.nodes.items()) or len(self.reserved.values()) != len(set(self.reserved.values())):
            raise RuntimeError('node_resource_conservation')

    def snapshot(self):
        return copy.deepcopy({'travelers': self.people, 'fleet': self.vehicles})

    def metrics(self):
        arrived = [p for p in self.people.values() if p['time'] <= self.time]
        wait = sum(p.get('hubDeparture', self.time) - p['time'] for p in arrived)
        def mean(values):
            return sum(values) / len(values) if values else None

        def p90(values):
            return sorted(values)[math.ceil(len(values) * 0.9) - 1] if values else None

        all_wait = [p['waitSeconds'] for p in arrived]
        completed = [p['completedAt'] - p['time'] for p in arrived if p['state'] == 'completed']
        censored = [p.get('completedAt', self.time) - p['time'] for p in arrived]
        route_metrics = {}
        for route_id in self.routes:
            people = [p for p in self.people.values() if p['route'] == route_id]
            seen = [p for p in people if p['time'] <= self.time]
            hub = [p.get('hubDeparture', self.time) - p['time'] for p in seen]
            waiting = [p['waitSeconds'] for p in seen]
            route_metrics[route_id] = dict(totalTravelers=len(people), arrivedTravelers=len(seen), states=dict(Counter(p['state'] for p in people)), completedJourneys=sum(p['state'] == 'completed' for p in people), meanHubWaitSeconds=mean(hub), p90HubWaitSeconds=p90(hub), meanAllWaitSeconds=mean(waiting), p90AllWaitSeconds=p90(waiting))
        fleet_metrics = {}
        for vid, vehicle in self.vehicles.items():
            busy = vehicle['busySeconds'] + (self.time - vehicle['busyStart'] if 'busyStart' in vehicle else 0)
            fleet_metrics[vid] = dict(capacity=vehicle['capacity'], observedTrips=vehicle['observedTrips'], passengersBoarded=vehicle['passengersBoarded'], busySeconds=busy, busyFraction=busy / self.time if self.time else None, loadFactor=vehicle['passengersBoarded'] / (vehicle['capacity'] * vehicle['observedTrips']) if vehicle['observedTrips'] else None,
                                      completedTurnaroundSeconds=vehicle['turnarounds'], meanCompletedTurnaroundSeconds=mean(vehicle['turnarounds']), censoredTurnaroundSeconds=self.time - vehicle['departureTime'] if 'departureTime' in vehicle else None)
        node_metrics = {node_id: dict(waiting=sum(p['location'] == node_id and p['state'] == 'waiting' for p in self.people.values()), walking=sum(p['location'] == node_id and p['state'] == 'walking' for p in self.people.values()), connecting=sum(p['location'] == node_id and p['state'] == 'connecting' for p in self.people.values()), blocked=sum(p['location'] == 'upstream:' + node_id and p['state'] == 'blocked' for p in self.people.values()), waitingCapacity=node['waitingCapacity']) for node_id, node in self.nodes.items()}
        return dict(totalTravelers=len(self.people), states=dict(Counter(p['state'] for p in self.people.values())), missedConnections=len(self.missed), lastServiceMisses=len(self.last_missed), dispatchedTrips=self.trips,
                    hubDepartures=sum('hubDeparture' in p for p in self.people.values()), completedJourneys=sum(p['state'] == 'completed' for p in self.people.values()),
                    arrivedTravelers=len(arrived), hubWaitPersonSeconds=wait, meanHubWaitSeconds=wait / len(arrived) if arrived else None,
                    waiting=dict(allWaitPersonSeconds=sum(all_wait), meanAllWaitSeconds=mean(all_wait), p90AllWaitSeconds=p90(all_wait), p90HubWaitSeconds=p90([p.get('hubDeparture', self.time) - p['time'] for p in arrived]), censoredPeople=sum('hubDeparture' not in p for p in arrived), definition='waiting + upstream blocked + boarding + connecting; walking and travel excluded; all arrived people, unfinished censored at finalTime; P90 nearest rank'),
                    journeys=dict(completedCount=len(completed), arrivedCount=len(arrived), meanCompletedSeconds=mean(completed), p90CompletedSeconds=p90(completed), meanCensoredSeconds=mean(censored), p90CensoredSeconds=p90(censored), definition='arrival to completion; completed-only statistics explicitly conditional; censored statistics retain every arrival at finalTime'),
                    byRoute=route_metrics, nodes=node_metrics, fleet=fleet_metrics,
                    fleetDefinition='busy from boarding reservation until actual return availability, censored at finalTime; fraction divides by elapsed simulation window; turnaround from actual departure to actual return availability; loadFactor is observed boardings / (observed trips * capacity), not road occupancy',
                    unit='person', units={**dict(totalTravelers='person', states='person', missedConnections='person', lastServiceMisses='person', dispatchedTrips='trip', hubDepartures='person', completedJourneys='person', arrivedTravelers='person', hubWaitPersonSeconds='person*s', meanHubWaitSeconds='s'), 'waiting.allWaitPersonSeconds': 'person*s', 'waiting.meanAllWaitSeconds': 's', 'waiting.p90AllWaitSeconds': 's', 'waiting.p90HubWaitSeconds': 's', 'journeys.meanCompletedSeconds': 's', 'journeys.p90CompletedSeconds': 's', 'journeys.meanCensoredSeconds': 's', 'journeys.p90CensoredSeconds': 's', 'fleet.busySeconds': 's', 'fleet.busyFraction': 'fraction', 'fleet.loadFactor': 'fraction', 'fleet.completedTurnaroundSeconds': 's', 'fleet.censoredTurnaroundSeconds': 's'},
                    window='All arrivals through finalTime; hub wait includes boarding and upstream blockage, right-censored at finalTime for travelers not departed; unfinished retained')
