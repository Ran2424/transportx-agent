"""Atomic complete blocks; necessary events occur once, sampled positions are separate."""
import hashlib
import json
import os
import time


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def atomic(root, name, value):
    data = encode(value)
    temporary = os.path.join(root, name + '.part')
    with open(temporary, 'wb') as file:
        file.write(data)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, os.path.join(root, name))
    return {'path': name, 'bytes': len(data), 'sha256': digest(data)}


class Blocks:
    def __init__(self, job):
        self.job = job
        self.root = job['execution']['outputRoot']
        self.chunks, self.events, self.frames = [], [], []
        self.start = None
        self.next_event = 0
        self.written_bytes = 0
        self.write_seconds = 0.0
        self.max_buffer_bytes = 0
        self.event_start = 0

    def emit(self, time_value, kind, object_id, **detail):
        self.events.append(dict(sequence=self.next_event, time=time_value, type=kind, objectId=object_id, **detail))
        self.next_event += 1

    def sample(self, state):
        if self.start is None:
            self.start = state
        if state['time'] % self.job['scenario']['sampleSeconds'] == 0:
            self.frames.append(state)
        self.last = state

    def publish(self, final=False):
        if self.start is None:
            return
        started = time.perf_counter()
        sequence = len(self.chunks)
        if final and (not self.frames or self.frames[-1]['time'] != self.last['time']):
            self.frames.append(self.last)
        block = {'protocol': 'transportx-simulation-block', 'version': 1, 'runId': self.job['runId'],
                 'sequence': sequence, 'networkSha256': self.job['network']['sha256'],
                 'start': self.start, 'frames': self.frames, 'eventStart': self.event_start,
                 'sampleSeconds': self.job['scenario']['sampleSeconds'], 'coordinateSystem': 'sumo-network-meters'}
        events = atomic(self.root, 'events-' + str(sequence) + '.json', self.events)
        entry = atomic(self.root, 'block-' + str(sequence) + '.json', block)
        if entry['bytes'] > 2 * 1024 * 1024 or events['bytes'] > 2 * 1024 * 1024:
            raise RuntimeError('block_budget_exceeded')
        self.written_bytes += events['bytes'] + entry['bytes']
        if self.written_bytes > self.job['execution']['maxOutputBytes']:
            raise RuntimeError('output_budget_exceeded')
        self.max_buffer_bytes = max(self.max_buffer_bytes, events['bytes'] + entry['bytes'])
        entry.update(sequence=sequence, fromTime=self.start['time'], toTime=self.last['time'],
                     availableTime=self.frames[-1]['time'], eventStart=self.event_start,
                     eventCount=len(self.events), events=events, publishedWallNs=time.time_ns())
        entry['from'] = self.start['time']
        self.chunks.append(entry)
        atomic(self.root, 'index.json', {'protocol': 'transportx-simulation-index', 'version': 1,
               'runId': self.job['runId'], 'networkSha256': self.job['network']['sha256'], 'revision': len(self.chunks),
               'availableTime': entry['availableTime'], 'computedTime': self.last['time'], 'final': final, 'chunks': self.chunks})
        self.write_seconds += time.perf_counter() - started
        self.start, self.frames, self.events = None, [], []
        self.event_start = self.next_event
