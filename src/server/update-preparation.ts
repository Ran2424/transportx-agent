export class UpdatePreparation {
  private activeOperations = 0;
  private token: string | null = null;

  beginOperation() {
    if (this.token) throw Object.assign(new Error('Host is preparing an update'), { status: 503 });
    this.activeOperations += 1;
    let completed = false;
    return () => { if (!completed) { completed = true; this.activeOperations -= 1; } };
  }

  async prepare(token: string, verifyAndSave: () => Promise<void>) {
    if (this.token || this.activeOperations) throw Object.assign(new Error('Host is busy'), { code: 'host_busy' });
    // Check and lock are synchronous: no new operation can race the idle check.
    this.token = token;
    try {
      await verifyAndSave();
      this.assertPrepared(token);
    } catch (error) {
      this.cancel(token);
      throw error;
    }
  }

  assertPrepared(token: string) {
    if (this.token !== token) throw new Error('Update preparation was cancelled');
  }

  cancel(token: string) { if (this.token === token) this.token = null; }
}
