"""P0 synthetic service ledger. No product state, Pi or TraCI imports."""
import copy
from collections import Counter


def validate_service(service):
    fields = {'busCapacity', 'boardingSeconds', 'transferSeconds', 'externalSeconds', 'departures', 'metro', 'travelers'}
    if not isinstance(service, dict) or set(service) != fields:
        raise ValueError('service_fields')
    for key in ('busCapacity', 'boardingSeconds', 'transferSeconds', 'externalSeconds'):
        if type(service[key]) is not int or not 1 <= service[key] <= 1000:
            raise ValueError('service_number')
    ids = set()
    for key, expected in [('departures', {'id', 'time', 'vehicle'}), ('metro', {'id', 'time', 'capacity'}), ('travelers', {'id', 'time', 'mode', 'destination'})]:
        rows = service[key]
        if not isinstance(rows, list) or not 1 <= len(rows) <= 1000:
            raise ValueError('service_rows')
        for row in rows:
            if not isinstance(row, dict) or set(row) != expected or type(row['time']) is not int or not 0 <= row['time'] <= 7200:
                raise ValueError('service_row')
            if not isinstance(row['id'], str) or not 1 <= len(row['id']) <= 160 or not row['id'].isascii() or not row['id'].replace('-', '').isalnum() or row['id'] in ids or row['id'] in ['bus-0', 'car-0', 'ridehail-first'] or row['id'].startswith('road-') and row['id'][5:].isdigit():
                raise ValueError('service_id')
            ids.add(row['id'])
            if key == 'departures' and row['vehicle'] != 'bus-0':
                raise ValueError('service_vehicle')
            if key == 'metro' and (type(row['capacity']) is not int or not 1 <= row['capacity'] <= 1000):
                raise ValueError('metro_capacity')
            if key == 'travelers' and (row['mode'], row['destination']) not in [('bus', 'east'), ('ridehail', 'west')]:
                raise ValueError('itinerary_unsupported')


class Ledger:
    def __init__(self, service):
        self.service = service
        self.people = {p['id']: dict(p, state='not_arrived', location=None) for p in service['travelers']}
        self.vehicles = {v: {'state': 'available', 'occupants': [], 'trip': None} for v in ['bus-0', 'car-0']}
        self.handled = set()
        self.waiting = []
        self.missed = set()
        self.trips = 0

    def update(self, time, road, emit):
        # Phase 1: effects observed from the engine, then service completion / resource release.
        for vehicle_id, vehicle in self.vehicles.items():
            actual = road.get(vehicle_id)
            if actual is None and vehicle['state'] == 'available':
                continue
            if actual is None:
                raise RuntimeError('fleet_vehicle_missing')
            if vehicle['state'] == 'commanded' and actual['speed'] > 0 and not actual['stopped']:
                vehicle['state'] = 'outbound'
                self.trips += 1
                emit('departure_observed', vehicle_id, trip=vehicle['trip'], nodeId='node:hub')
                for pid in vehicle['occupants']:
                    p = self.people[pid]
                    p.update(state='riding', location=vehicle_id, hubDeparture=time)
                    emit('boarded', pid, vehicle=vehicle_id, trip=vehicle['trip'], nodeId='node:hub')
            if vehicle['state'] == 'outbound' and actual['edgeRole'] == 'relay' and actual['stopped']:
                for pid in vehicle['occupants']:
                    p = self.people[pid]
                    state = 'walking' if p['mode'] == 'bus' else 'external'
                    duration = self.service['transferSeconds'] if state == 'walking' else self.service['externalSeconds']
                    p.update(state=state, location='relay' if state == 'walking' else 'external-west', ready=time + duration)
                    emit('alighted', pid, vehicle=vehicle_id, nodeId='node:relay')
                vehicle['occupants'] = []
                vehicle['state'] = 'returning'
                self.waiting.append({'kind': 'return', 'vehicle': vehicle_id})
            if vehicle['state'] == 'returning' and actual['edgeRole'] == 'hub' and actual['stopped']:
                vehicle.update(state='available', trip=None)
                emit('vehicle_available', vehicle_id, nodeId='node:hub')
        for pid, p in sorted(self.people.items()):
            if p['state'] in ['walking', 'external'] and time >= p['ready']:
                if p['state'] == 'walking':
                    p.update(state='connecting', location='relay')
                    emit('transfer_ready', pid, nodeId='node:relay')
                else:
                    p.update(state='completed', location=p['destination'], completedAt=time)
                    emit('journey_completed', pid)
        # Phase 2: t0 and same-time arrivals, stable IDs; no knowledge of future demand in decisions.
        for pid, p in sorted(self.people.items()):
            if p['state'] == 'not_arrived' and p['time'] <= time:
                p.update(state='waiting', location='hub')
                emit('traveler_arrived', pid, nodeId='node:hub')
        # Phase 3: close scheduled services only after arrivals, reserve resources sequentially.
        departures = list(self.service['departures'])
        departures += [{'id': 'ridehail-first', 'time': 5, 'vehicle': 'car-0'}]
        for trip in sorted(departures, key=lambda v: (v['time'], v['id'])):
            if trip['time'] > time or trip['id'] in self.handled:
                continue
            self.handled.add(trip['id'])
            vid = trip['vehicle']
            emit('action_candidate', trip['id'], vehicle=vid, nodeId='node:hub')
            vehicle, actual = self.vehicles[vid], road.get(vid)
            mode = 'bus' if vid == 'bus-0' else 'ridehail'
            queue = sorted((p for p in self.people.values() if p['state'] == 'waiting' and p['mode'] == mode), key=lambda p: (p['time'], p['id']))
            reason = ('vehicle_reserved' if vehicle['state'] != 'available' else
                      'vehicle_not_at_berth' if not actual or actual['edgeRole'] != 'hub' or not actual['stopped'] else
                      'no_matching_demand' if not queue else None)
            if reason:
                emit('action_rejected', trip['id'], vehicle=vid, reason=reason, nodeId='node:hub')
                continue
            capacity = self.service['busCapacity'] if mode == 'bus' else 1
            chosen = queue[:capacity]
            vehicle.update(state='boarding', occupants=[p['id'] for p in chosen], trip=trip['id'], ready=time + self.service['boardingSeconds'])
            for p in chosen:
                p.update(state='boarding', location=vid)
            emit('action_reserved', trip['id'], vehicle=vid, travelers=vehicle['occupants'], nodeId='node:hub')
        for vid, vehicle in self.vehicles.items():
            if vehicle['state'] == 'boarding' and time >= vehicle['ready']:
                vehicle['state'] = 'commanded'
                self.waiting.append({'kind': 'dispatch', 'vehicle': vid, 'trip': vehicle['trip']})
        for train in sorted(self.service['metro'], key=lambda v: (v['time'], v['id'])):
            if train['time'] > time or train['id'] in self.handled:
                continue
            self.handled.add(train['id'])
            queue = sorted((p for p in self.people.values() if p['state'] == 'connecting'), key=lambda p: (p['ready'], p['id']))
            for p in queue[:train['capacity']]:
                p.update(state='external', location=train['id'], ready=time + self.service['externalSeconds'])
                emit('metro_boarded', p['id'], service=train['id'], nodeId='node:relay')
            for p in queue[train['capacity']:]:
                self.missed.add(p['id'])
                emit('connection_missed', p['id'], service=train['id'], reason='capacity', nodeId='node:relay')
        last = max(train['time'] for train in self.service['metro'])
        if time >= last:
            for pid, p in sorted(self.people.items()):
                if p['state'] == 'connecting' and pid not in self.missed:
                    self.missed.add(pid)
                    emit('connection_missed', pid, reason='last_service_closed', nodeId='node:relay')
        self.check()

    def apply(self, engine, emit):
        for action in self.waiting:
            engine.release(action['vehicle'], action['kind'])
            emit('engine_accepted', action['vehicle'], action=action['kind'], trip=action.get('trip'), nodeId='node:hub' if action['kind'] == 'dispatch' else 'node:relay')
        self.waiting.clear()

    def check(self):
        occupants = [pid for vehicle in self.vehicles.values() for pid in vehicle['occupants']]
        if len(occupants) != len(set(occupants)):
            raise RuntimeError('duplicate_occupancy')
        for vid, vehicle in self.vehicles.items():
            capacity = self.service['busCapacity'] if vid == 'bus-0' else 1
            if len(vehicle['occupants']) > capacity:
                raise RuntimeError('capacity_exceeded')
            for pid in vehicle['occupants']:
                p = self.people[pid]
                if p['state'] not in ['boarding', 'riding'] or p['location'] != vid:
                    raise RuntimeError('occupancy_mismatch')
        if sorted(occupants) != sorted(pid for pid, p in self.people.items() if p['state'] in ['boarding', 'riding']):
            raise RuntimeError('traveler_conservation')

    def snapshot(self):
        return copy.deepcopy({'travelers': self.people, 'fleet': self.vehicles})

    def metrics(self):
        states = dict(Counter(p['state'] for p in self.people.values()))
        return {'totalTravelers': len(self.people), 'states': states, 'missedConnections': len(self.missed), 'dispatchedTrips': self.trips,
                'unit': 'person', 'window': 'arrived through finalTime; unfinished retained',
                'units': {'totalTravelers': 'person', 'states': 'person', 'missedConnections': 'person', 'dispatchedTrips': 'trip', 'hubDepartures': 'person', 'completedJourneys': 'person'},
                'hubDepartures': sum('hubDeparture' in p for p in self.people.values()),
                'completedJourneys': sum(p['state'] == 'completed' for p in self.people.values())}
