"""Pinned SUMO 1.28 TraCI adapter for the bounded road and service profiles."""
import os
import subprocess
import time
import xml.etree.ElementTree as ET
import traci
from sumolib.miscutils import getFreeSocketPort
from blocks import atomic


class Engine:
    def __init__(self, job, is_cancelled=lambda: False):
        self.job = job
        self.timings = {'stepSeconds': 0.0, 'readSeconds': 0.0, 'routeSeconds': 0.0, 'actionSeconds': 0.0}
        execution, scenario = job['execution'], job['scenario']
        root = execution['outputRoot']
        self.command = [execution['sumo'], '--net-file', job['network']['path'], '--begin', '0',
                        '--step-length', str(scenario['stepSeconds']), '--seed', str(scenario['seed']),
                        '--no-step-log', 'true', '--duration-log.disable', 'true', '--time-to-teleport', '-1',
                        '--xml-validation', 'never', '--tripinfo-output', os.path.join(root, 'tripinfo.xml'),
                        '--tripinfo-output.write-unfinished', 'true', '--tripinfo-output.write-undeparted', 'true', '--error-log', os.path.join(root, 'sumo-errors.log')]
        if execution.get('projData'):
            os.environ['PROJ_DATA'] = execution['projData']
        port = getFreeSocketPort()
        self.command += ['--remote-port', str(port)]
        self.stdout = open(os.path.join(root, 'sumo.log'), 'w')
        self.process = subprocess.Popen(self.command, stdout=self.stdout)
        atomic(root, 'started.json', {'pythonPid': os.getpid(), 'sumoPid': self.process.pid,
               'command': self.command, 'environmentKeys': sorted(os.environ), 'startedWallNs': time.time_ns()})
        deadline = time.monotonic() + execution['wallSeconds']
        try:
            while True:
                if is_cancelled():
                    raise RuntimeError('cancelled_during_engine_start')
                if self.process.poll() is not None:
                    raise RuntimeError('engine_start_failed')
                try:
                    self.connection = traci.connect(port, numRetries=0, host='127.0.0.1', proc=self.process, label='transportx')
                    traci.switch('transportx')
                    break
                except (traci.exceptions.FatalTraCIError, traci.exceptions.TraCIException, OSError):
                    if time.monotonic() >= deadline:
                        raise RuntimeError('engine_start_timed_out')
                    time.sleep(0.02)
            self.initialize(job)
        except BaseException:
            self.process.terminate()
            try:
                self.process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=1)
            self.stdout.close()
            raise

    def initialize(self, job):
        scenario = job['scenario']
        self.version = traci.getVersion()
        self.departed, self.arrived = set(), set()
        self.scheduled = {'road-' + str(i): i * 2 for i in range(scenario['backgroundCount'])}
        self.pending, self.active, self.not_due = set(), set(), set()
        self.peak_active = 0
        self.fleet = scenario['model'] == 'evacuation'
        self.roles = job['mapping'].get('edges', {})
        self.inverse_roles = {edge: role for role, edge in self.roles.items()}
        location = ET.parse(job['network']['path']).getroot().find('location')
        self.geographic = location is not None and location.get('projParameter', '!') not in ['', '!']
        start = time.perf_counter()
        road_route = job['mapping']['roadRoute']
        traci.simulation.findRoute(road_route[0], road_route[-1])
        self.timings['routeSeconds'] += time.perf_counter() - start
        traci.route.add('road', road_route)
        for i in range(scenario['backgroundCount']):
            traci.vehicle.add('road-' + str(i), 'road', depart=str(i * 2), departLane='free', departSpeed='max')
        if self.fleet:
            self.scheduled.update({'bus-0': 0, 'car-0': 0})
            self.fleet_route = [self.roles[key] for key in ['hub', 'outbound', 'relay', 'inbound', 'hub']]
            traci.route.add('fleet', self.fleet_route)
            traci.vehicletype.copy('DEFAULT_VEHTYPE', 'p0-shuttle')
            traci.vehicletype.setVehicleClass('p0-shuttle', 'bus')
            for i, vehicle in enumerate(['bus-0', 'car-0']):
                traci.vehicle.add(vehicle, 'fleet', typeID='p0-shuttle' if i == 0 else 'DEFAULT_VEHTYPE', depart='0', departPos='20', departLane=str(i), departSpeed='0')
                traci.vehicle.setStop(vehicle, self.roles['hub'], pos=20, laneIndex=i, duration=100000.0)

    def step(self):
        started = time.perf_counter()
        traci.simulationStep()
        self.timings['stepSeconds'] += time.perf_counter() - started

    def observe(self, expected_time):
        started = time.perf_counter()
        departed = list(traci.simulation.getDepartedIDList())
        arrived = list(traci.simulation.getArrivedIDList())
        self.departed.update(departed)
        self.arrived.update(arrived)
        if traci.simulation.getStartingTeleportNumber() or traci.simulation.getCollidingVehiclesNumber():
            raise RuntimeError('road_anomaly')
        vehicles = {}
        for vid in sorted(traci.vehicle.getIDList()):
            x, y = traci.vehicle.getPosition(vid)
            vehicles[vid] = {'edge': traci.vehicle.getRoadID(vid), 'lane': traci.vehicle.getLaneID(vid),
                             'position': [x, y], 'lanePositionMeters': traci.vehicle.getLanePosition(vid),
                             'speed': traci.vehicle.getSpeed(vid), 'stopped': bool(traci.vehicle.getStopState(vid) & 1)}
            vehicles[vid]['edgeRole'] = self.inverse_roles.get(vehicles[vid]['edge'])
            if self.geographic:
                vehicles[vid]['positionGeo'] = list(traci.simulation.convertGeo(x, y))
        self.active = set(vehicles)
        self.peak_active = max(self.peak_active, len(vehicles))
        self.pending = set(traci.simulation.getPendingVehicles())
        computed = traci.simulation.getTime()
        if computed != expected_time:
            raise RuntimeError('engine_clock_mismatch')
        self.not_due = {vid for vid, depart in self.scheduled.items() if depart >= computed and vid not in self.departed and vid not in self.pending}
        known = self.departed | self.pending | self.not_due
        if known != set(self.scheduled) or self.departed & self.pending or self.active != self.departed - self.arrived:
            raise RuntimeError('road_vehicle_conservation')
        self.timings['readSeconds'] += time.perf_counter() - started
        return vehicles, departed, arrived

    def release(self, vehicle, kind):
        started = time.perf_counter()
        if not traci.vehicle.getStopState(vehicle) & 1:
            raise RuntimeError('engine_stop_unconfirmed')
        target = self.roles['relay' if kind == 'dispatch' else 'hub']
        if kind == 'dispatch':
            traci.vehicle.setRoute(vehicle, self.fleet_route)
        traci.vehicle.setStop(vehicle, target, pos=20, laneIndex=0 if vehicle == 'bus-0' else 1, duration=100000.0)
        traci.vehicle.resume(vehicle)
        self.timings['actionSeconds'] += time.perf_counter() - started

    def close(self, cancelled=False):
        failure = None
        try:
            traci.close()  # waits for SUMO; a requested close alone is not exit confirmation.
        except Exception as error:
            failure = error
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=1)
        if self.process.poll() is None:
            raise RuntimeError('engine_exit_unconfirmed')
        self.stdout.close()
        if failure and not cancelled:
            raise failure
        if not cancelled and self.process.poll() != 0:
            raise RuntimeError('engine_completion_unconfirmed')

    @property
    def exited(self):
        return self.process.poll() is not None

    @property
    def exit_code(self):
        return self.process.poll()
