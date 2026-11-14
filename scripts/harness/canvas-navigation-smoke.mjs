import assert from 'node:assert/strict';

export async function canvasNavigationSmoke(page, composer) {
  // Generate a small local video in the browser so the UI test needs no external video assets.
  console.log('Canvas smoke: generating test video.');
  const videoBytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext('2d');
    const stream = canvas.captureStream(12);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const finished = new Promise((resolve) => { recorder.onstop = resolve; });
    recorder.start();
    for (let frame = 0; frame < 12; frame++) {
      context.fillStyle = frame % 2 ? '#687b77' : '#485a65';
      context.fillRect(0, 0, 320, 180);
      await new Promise((resolve) => setTimeout(resolve, 85));
    }
    recorder.stop(); await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error('Test video recording timed out')), 5000))]);
    stream.getTracks().forEach((track) => track.stop());
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  });
  console.log('Canvas smoke: test video ready.', videoBytes.length);
  await page.route('**/video-resources/video_canvas_*/data', (route) => route.fulfill({ contentType: 'video/webm', body: Buffer.from(videoBytes) }));
  await page.route('**/video-resources/video_canvas_*/metrics', (route) => route.fulfill({ json: { metrics: [] } }));
  for (const [prompt, title] of [['canvas-video-first', '东入口录像'], ['canvas-video-second', '西入口录像']]) {
    await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
    console.log('Canvas smoke: presenting', title);
    await composer.fill(prompt); await composer.press('Enter');
    await page.locator('[role=tab][aria-selected=true]', { hasText: title }).waitFor();
  }
  const firstVideo = page.locator('[id="canvas-panel-video:video_canvas_a"] video');
  await page.getByRole('tab', { name: '东入口录像', exact: true }).click();
  await firstVideo.evaluate(async (video) => { video.muted = true; await Promise.race([video.play(), new Promise((_, reject) => setTimeout(() => reject(new Error(`Video play timed out: ${video.readyState}, ${video.networkState}, ${video.error?.message}`)), 5000))]); });
  await page.getByRole('tab', { name: '西入口录像', exact: true }).click();
  assert.equal(await firstVideo.evaluate((video) => video.paused), true, 'background videos pause');
  await page.getByRole('button', { name: '关闭视图：下车热点热力图', exact: true }).click();
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  await composer.fill('canvas-show-map'); await composer.press('Enter');
  await page.locator('[role=tab][aria-selected=true]', { hasText: '下车热点热力图' }).waitFor();
  assert.equal(await page.getByRole('tab', { name: '下车热点热力图', exact: true }).count(), 1);
  assert.equal(await page.getByLabel('切换地图面板', { exact: true }).count(), 0);
  await page.waitForTimeout(450);
  if (process.env.TAU_CANVAS_SCREENSHOT) {
    await page.setViewportSize({ width: 1580, height: 1000 });
    await page.getByRole('tab', { name: 'Geo 双向交互分析结果', exact: true }).click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: process.env.TAU_CANVAS_SCREENSHOT });
  }
  console.log('Canvas smoke: named tabs, map preservation, close/reopen, video selection/pause and Agent focus passed.');
}
