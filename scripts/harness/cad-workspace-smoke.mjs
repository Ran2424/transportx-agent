import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// A non-traffic drawing proves that the workspace does not impose a road workflow.
export async function cadWorkspaceSmoke({ execute, session, page, panel, output }) {
  const python = process.env.TAU_PYTHON_COMMAND || 'python3';
  execFileSync(python, ['-c', `
import sys, pathlib, ezdxf
p=pathlib.Path(sys.argv[1]);d=ezdxf.new('R2010');d.header['$INSUNITS']=4
d.layers.add('EQUIPMENT');d.layers.add('LABELS')
d.modelspace().add_lwpolyline([(0,0),(100,0),(100,60),(0,60)],close=True,dxfattribs={'layer':'EQUIPMENT'})
d.modelspace().add_text('LAYOUT',height=5,dxfattribs={'layer':'LABELS'}).set_placement((10,20))
d.saveas(p/'layout-candidate.dxf')
`, session.cwd]);
  const first = (await execute('cad_draw', { kind: 'import', fileId: 'layout', sourcePath: 'layout-candidate.dxf', units: 'mm', title: 'Equipment layout' })).details.result;
  const tab = page.getByRole('tab', { name: 'Equipment layout', exact: true });
  await tab.waitFor();
  await panel.locator('.cad-canvas-badge', { hasText: 'r1' }).waitFor();
  const observed = JSON.parse((await execute('cad_inspect', { fileId: 'layout', include: ['geometry'] })).content[0].text);
  assert.equal(observed.entities.find((entity) => entity.type === 'LWPOLYLINE').geometry.points.length, 4);
  execFileSync(python, ['-c', `
import sys,pathlib,ezdxf
p=pathlib.Path(sys.argv[1]);d=ezdxf.readfile(p/'cad/layout/r1.dxf')
d.modelspace().add_circle((70,30),10,dxfattribs={'layer':'EQUIPMENT'})
d.saveas(p/'layout-candidate.dxf')
`, session.cwd]);
  const candidate = await execute('cad_draw', { kind: 'commit-candidate', fileId: 'layout', sourcePath: 'layout-candidate.dxf', baseRevision: 1, expectedSha256: first.drawing.sha256, candidateMode: 'based-on-current' });
  const receipt = JSON.parse(candidate.content[0].text.split('\n').at(-1));
  assert.equal(receipt.references.requeryRequired, true);
  assert.equal(receipt.presentation.status, 'accepted');
  assert.equal(receipt.presentation.browserRenderConfirmed, false);
  await panel.locator('.cad-canvas-badge', { hasText: 'r2' }).waitFor();
  const reopened = (await execute('canvas_present', { adapterId: 'com.transportx.canvas.cad', resource: { scope: 'session-file', path: 'layout-candidate.dxf' } })).details.canvas;
  assert.equal(reopened.viewId, first.canvas.viewId);
  assert.equal(await tab.count(), 1, 'candidate commits and source opening keep one view');
  const circle = JSON.parse((await execute('cad_inspect', { fileId: 'layout', include: ['geometry'] })).content[0].text).entities.find((entity) => entity.type === 'CIRCLE');
  const native = (await execute('cad_draw', { kind: 'edit', fileId: 'layout', baseRevision: 2, expectedSha256: candidate.details.result.drawing.sha256, operations: [{ op: 'move', selector: { kind: 'handle', handle: circle.handle }, dx: 5, dy: 0 }] })).details.result;
  assert.equal(native.canvas.viewId, first.canvas.viewId);
  await panel.locator('.cad-canvas-badge', { hasText: 'r3' }).waitFor();
  const local = JSON.parse((await execute('cad_verify', { fileId: 'layout', exportPreview: true, previewOptions: { bounds: { min: [50, 10], max: [95, 50] }, layers: ['EQUIPMENT'], width: 800, height: 600 } })).content[0].text);
  assert.equal(local.preview.width, 800);
  const image = execFileSync(python, ['-c', 'from PIL import Image;import sys;im=Image.open(sys.argv[1]);assert im.size==(800,600)', path.join(session.cwd, local.preview.png)]);
  assert.equal(image.length, 0);
  const confirmed = JSON.parse((await execute('cad_inspect', { fileId: 'layout', include: ['geometry'] })).content[0].text);
  assert.deepEqual(confirmed.entities.find((entity) => entity.type === 'CIRCLE').geometry.center, [75, 30]);
  await page.screenshot({ path: path.join(output, 'cad-python-workspace.png') });
  return { pythonCandidateRevision: true, sameView: true, nativeEditAfterPython: true, preciseObservation: true, localPreview: true };
}
